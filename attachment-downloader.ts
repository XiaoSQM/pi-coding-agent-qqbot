import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 300;

export type SniffedMedia =
	| { kind: "image"; mimeType: "image/jpeg" | "image/png" | "image/gif"; extension: string }
	| { kind: "audio"; mimeType: string; extension: string }
	| { kind: "pdf"; mimeType: "application/pdf"; extension: ".pdf" }
	| { kind: "doc"; mimeType: "application/msword"; extension: ".doc" }
	| { kind: "text"; mimeType: "text/plain"; extension: ".txt" }
	| { kind: "archive"; mimeType: string; extension: string }
	| { kind: "unknown"; mimeType: "application/octet-stream"; extension: string };

export interface DownloadedAttachment {
	path: string;
	bytes: number;
	media: SniffedMedia;
	responseContentType?: string;
}

export interface AttachmentDownloaderOptions {
	runtimeId: string;
	messageId: string;
	timeoutMs: number;
	signal: AbortSignal;
	onProgress?: (bytes: number) => void;
}

export class AttachmentDownloadError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export class AttachmentDownloader {
	private readonly workspace: string;
	private readonly timeoutMs: number;
	private readonly signal: AbortSignal;
	private readonly onProgress?: (bytes: number) => void;
	private totalBytes = 0;

	constructor(options: AttachmentDownloaderOptions) {
		this.workspace = join(tmpdir(), "pi-qqbot", safeSegment(options.runtimeId), safeSegment(options.messageId));
		this.timeoutMs = options.timeoutMs;
		this.signal = options.signal;
		this.onProgress = options.onProgress;
	}

	async download(url: string, maxBytes: number, remainingTotalBytes: number): Promise<DownloadedAttachment> {
		const effectiveMax = Math.max(0, Math.min(maxBytes, remainingTotalBytes));
		if (effectiveMax <= 0) throw new AttachmentDownloadError("size_limit", "消息附件总大小超过限制");
		await mkdir(this.workspace, { recursive: true, mode: 0o700 });

		const downloaded = await this.downloadWithRetries(url, effectiveMax);
		this.totalBytes += downloaded.bytes;
		return downloaded;
	}

	async downloadFirst(
		urls: string[],
		maxBytes: number,
		remainingTotalBytes: number,
	): Promise<DownloadedAttachment> {
		const effectiveMax = Math.max(0, Math.min(maxBytes, remainingTotalBytes));
		if (effectiveMax <= 0) throw new AttachmentDownloadError("size_limit", "消息附件总大小超过限制");
		await mkdir(this.workspace, { recursive: true, mode: 0o700 });
		let lastError: unknown;
		for (const url of urls) {
			try {
				const downloaded = await this.downloadWithRetries(url, effectiveMax);
				this.totalBytes += downloaded.bytes;
				return downloaded;
			} catch (err) {
				lastError = err;
			}
		}
		throw normalizeDownloadError(lastError);
	}

	get downloadedBytes(): number {
		return this.totalBytes;
	}

	async cleanup(): Promise<void> {
		await rm(this.workspace, { recursive: true, force: true }).catch(() => undefined);
	}

	private async downloadWithRetries(sourceUrl: string, maxBytes: number): Promise<DownloadedAttachment> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.downloadAttempt(sourceUrl, maxBytes);
			} catch (err) {
				lastError = err;
				if (!isRetryable(err) || attempt === MAX_RETRIES) break;
				await abortableDelay(RETRY_BASE_MS * 2 ** attempt, this.signal);
			}
		}
		throw normalizeDownloadError(lastError);
	}

	private async downloadAttempt(sourceUrl: string, maxBytes: number): Promise<DownloadedAttachment> {
		const controller = new AbortController();
		if (this.signal.aborted) throw new AttachmentDownloadError("aborted", "附件处理已取消");
		const onAbort = () => controller.abort(this.signal.reason);
		this.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => controller.abort(new Error("download timeout")), this.timeoutMs);
		let filePath: string | undefined;
		try {
			const { response } = await requestWithValidatedRedirects(sourceUrl, controller.signal, maxBytes);

			filePath = join(this.workspace, randomUUID());
			let bytes = 0;
			const body = response;
			body.on("data", (chunk: Buffer | Uint8Array | string) => {
				bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
				if (bytes > maxBytes) {
					controller.abort(new AttachmentDownloadError("size_limit", `附件超过大小限制（${formatBytes(maxBytes)}）`));
					return;
				}
				this.onProgress?.(bytes);
			});
			await pipeline(body, createWriteStream(filePath, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
			await chmod(filePath, 0o600);
			const info = await stat(filePath);
			if (info.size > maxBytes) throw new AttachmentDownloadError("size_limit", "附件超过大小限制");
			const head = await readHead(filePath, 8192);
			return {
				path: filePath,
				bytes: info.size,
				media: sniffMedia(head, headerValue(response, "content-type"), sourceUrl),
				responseContentType: headerValue(response, "content-type")?.split(";", 1)[0].trim().toLowerCase(),
			};
		} catch (err) {
			if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
			if (this.signal.aborted) throw new AttachmentDownloadError("aborted", "附件处理已取消");
			if (controller.signal.aborted && !isAttachmentDownloadError(controller.signal.reason)) {
				throw new AttachmentDownloadError("download_timeout", "附件下载超时");
			}
			if (isAttachmentDownloadError(controller.signal.reason)) throw controller.signal.reason;
			throw err;
		} finally {
			clearTimeout(timeout);
			this.signal.removeEventListener("abort", onAbort);
		}
	}
}

async function requestWithValidatedRedirects(
	sourceUrl: string,
	signal: AbortSignal,
	maxBytes: number,
): Promise<{ response: IncomingMessage; url: URL }> {
	let current = parseAndValidateUrl(sourceUrl);
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		let response: IncomingMessage;
		try {
			response = await requestPinned(current, signal);
		} catch (err) {
			if (signal.aborted) throw err;
			throw new AttachmentDownloadError("network_error", `附件下载网络错误：${safeError(err)}`);
		}
		const status = response.statusCode ?? 0;
		if (status >= 300 && status < 400) {
			const location = headerValue(response, "location");
			response.resume();
			if (!location) throw new AttachmentDownloadError("http_error", `下载重定向缺少 Location（HTTP ${status}）`);
			if (redirects === MAX_REDIRECTS) throw new AttachmentDownloadError("too_many_redirects", "附件下载重定向次数过多");
			current = parseAndValidateUrl(new URL(location, current).toString());
			continue;
		}
		if (status < 200 || status >= 300) {
			response.resume();
			throw new AttachmentDownloadError(
				status === 429 || status >= 500 ? `retryable_http_${status}` : "http_error",
				`附件下载失败（HTTP ${status}）`,
			);
		}
		const length = parseContentLength(headerValue(response, "content-length") ?? null);
		if (length !== undefined && length > maxBytes) {
			response.resume();
			throw new AttachmentDownloadError("size_limit", `附件超过大小限制（${formatBytes(maxBytes)}）`);
		}
		return { response, url: current };
	}
	throw new AttachmentDownloadError("too_many_redirects", "附件下载重定向次数过多");
}

async function requestPinned(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
	const addresses = await resolvePublicHost(url.hostname);
	return new Promise((resolve, reject) => {
		let settled = false;
		const req = httpsRequest(
			url,
			{
				method: "GET",
				signal,
				headers: { Accept: "*/*", "User-Agent": "pi-qqbot/0.2" },
				lookup: (_hostname, options, callback) => {
					const wantsAll = typeof options === "object" && options !== null && options.all === true;
					if (wantsAll) callback(null, addresses);
					else callback(null, addresses[0].address, addresses[0].family);
				},
			},
			(response) => {
				settled = true;
				resolve(response);
			},
		);
		req.once("error", (err) => {
			if (!settled) reject(err);
		});
		req.end();
	});
}

function headerValue(response: IncomingMessage, name: string): string | undefined {
	const value = response.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

export function parseAndValidateUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AttachmentDownloadError("invalid_url", "附件 URL 无效");
	}
	if (url.protocol !== "https:") throw new AttachmentDownloadError("invalid_url", "附件 URL 必须使用 HTTPS");
	if (url.username || url.password) throw new AttachmentDownloadError("invalid_url", "附件 URL 不允许包含用户名或密码");
	if (!url.hostname) throw new AttachmentDownloadError("invalid_url", "附件 URL 缺少主机名");
	return url;
}

export async function validatePublicHost(hostname: string): Promise<void> {
	await resolvePublicHost(hostname);
}

async function resolvePublicHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost")) {
		throw new AttachmentDownloadError("ssrf_blocked", "附件 URL 指向本地主机");
	}
	let addresses: Array<{ address: string; family: number }>;
	try {
		if (isIP(normalized)) addresses = [{ address: normalized, family: isIP(normalized) }];
		else addresses = await lookup(normalized, { all: true, verbatim: true });
	} catch {
		throw new AttachmentDownloadError("dns_failed", "附件主机 DNS 解析失败");
	}
	if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
		throw new AttachmentDownloadError("ssrf_blocked", "附件 URL 解析到了非公网地址");
	}
	return addresses;
}

export function isPublicAddress(address: string): boolean {
	const normalized = address.toLowerCase().split("%")[0];
	const family = isIP(normalized);
	if (family === 4) {
		const parts = normalized.split(".").map(Number);
		if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
		const [a, b, c] = parts;
		return !(
			a === 0 || a === 10 || a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0 && c === 0) ||
			(a === 192 && b === 0 && c === 2) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113) ||
			a >= 224
		);
	}
	if (family === 6) {
		if (normalized === "::" || normalized === "::1") return false;
		if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
		const firstText = normalized.split(":", 1)[0];
		const first = firstText ? Number.parseInt(firstText, 16) : 0;
		return !(
			(first & 0xfe00) === 0xfc00 || // unique local fc00::/7
			(first & 0xffc0) === 0xfe80 || // link-local fe80::/10
			(first & 0xff00) === 0xff00 || // multicast
			normalized.startsWith("2001:db8:") ||
			normalized.startsWith("2001:db8::")
		);
	}
	return false;
}

export function sniffMedia(head: Uint8Array, contentType?: string | null, sourceName = ""): SniffedMedia {
	const b = Buffer.from(head);
	if (starts(b, [0xff, 0xd8, 0xff])) return { kind: "image", mimeType: "image/jpeg", extension: ".jpg" };
	if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mimeType: "image/png", extension: ".png" };
	if (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a") {
		return { kind: "image", mimeType: "image/gif", extension: ".gif" };
	}
	if (b.subarray(0, 5).toString("ascii") === "%PDF-") return { kind: "pdf", mimeType: "application/pdf", extension: ".pdf" };
	if (starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: "doc", mimeType: "application/msword", extension: ".doc" };
	if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WAVE") {
		return { kind: "audio", mimeType: "audio/wav", extension: ".wav" };
	}
	if (b.subarray(0, 3).toString("ascii") === "ID3" || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
		return { kind: "audio", mimeType: "audio/mpeg", extension: ".mp3" };
	}
	if (b.subarray(0, 4).toString("ascii") === "OggS") return { kind: "audio", mimeType: "audio/ogg", extension: ".ogg" };
	if (b.subarray(0, 4).toString("ascii") === "fLaC") return { kind: "audio", mimeType: "audio/flac", extension: ".flac" };
	if (starts(b, [0x50, 0x4b, 0x03, 0x04]) || starts(b, [0x50, 0x4b, 0x05, 0x06]) || starts(b, [0x50, 0x4b, 0x07, 0x08])) {
		return { kind: "archive", mimeType: "application/zip", extension: ".zip" };
	}
	if (starts(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { kind: "archive", mimeType: "application/vnd.rar", extension: ".rar" };
	if (starts(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "archive", mimeType: "application/x-7z-compressed", extension: ".7z" };

	const declared = contentType?.split(";", 1)[0].trim().toLowerCase();
	let extension = "";
	try {
		extension = extname(new URL(sourceName, "https://placeholder.invalid").pathname).toLowerCase();
	} catch {
		extension = extname(sourceName).toLowerCase();
	}
	if (declared?.startsWith("text/") || extension === ".txt" || looksTextual(b)) {
		return { kind: "text", mimeType: "text/plain", extension: ".txt" };
	}
	return { kind: "unknown", mimeType: "application/octet-stream", extension };
}

export function safeOriginalFilename(value: string): string {
	const cleaned = basename(value || "attachment")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[<>:"/\\|?*]/g, "_")
		.trim();
	return (cleaned || "attachment").slice(0, 180);
}

export function safeUrlForLog(value: string): string {
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		return "(invalid-url)";
	}
}

async function readHead(path: string, length: number): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

function parseContentLength(value: string | null): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function looksTextual(data: Buffer): boolean {
	if (!data.length) return true;
	let controls = 0;
	for (const value of data) {
		if (value === 0) return false;
		if (value < 9 || (value > 13 && value < 32)) controls++;
	}
	return controls / data.length < 0.01;
}

function starts(value: Buffer, bytes: number[]): boolean {
	return bytes.every((byte, index) => value[index] === byte);
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 100) || randomUUID();
}

function isAttachmentDownloadError(value: unknown): value is AttachmentDownloadError {
	return value instanceof AttachmentDownloadError;
}

function isRetryable(err: unknown): boolean {
	return err instanceof AttachmentDownloadError && (err.code === "network_error" || err.code.startsWith("retryable_http_"));
}

function normalizeDownloadError(err: unknown): AttachmentDownloadError {
	if (err instanceof AttachmentDownloadError) return err;
	return new AttachmentDownloadError("download_failed", `附件下载失败：${safeError(err)}`);
}

function safeError(err: unknown): string {
	return err instanceof Error ? err.message.replace(/https?:\/\/\S+/g, "[URL]") : String(err);
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
