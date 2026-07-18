/**
 * QQ Bot outbound passive-reply API for plain text and native Markdown.
 * A conservative maximum of four chunks is enforced by the router because QQ's
 * current documentation contains conflicting historical 4/5 reply limits.
 */

import type { QQAuth } from "./qq-auth.ts";
import type { QQKeyboard, QQMediaUploadResult, QQReplyTarget } from "./types.ts";

const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";

export interface QQApiOptions {
	sandbox: boolean;
}

export class QQApiError extends Error {
	readonly status: number;
	readonly code?: number;
	readonly requestAccepted: boolean;
	constructor(message: string, status: number, code?: number, requestAccepted = false) {
		super(message);
		this.status = status;
		this.code = code;
		this.requestAccepted = requestAccepted;
	}
}

export class QQApi {
	private readonly auth: QQAuth;
	private readonly base: string;

	constructor(auth: QQAuth, opts: QQApiOptions) {
		this.auth = auth;
		this.base = opts.sandbox ? SANDBOX_BASE : PROD_BASE;
	}

	async sendText(target: QQReplyTarget, content: string, msgSeq: number): Promise<void> {
		await this.send(target, { content, msg_type: 0, msg_id: target.msgId, msg_seq: msgSeq });
	}

	async sendMarkdown(
		target: QQReplyTarget,
		content: string,
		msgSeq: number,
		keyboard?: QQKeyboard,
	): Promise<void> {
		await this.send(target, {
			markdown: { content },
			msg_type: 2,
			msg_id: target.msgId,
			msg_seq: msgSeq,
			...(keyboard ? { keyboard } : {}),
			// QQ documents group content as required even for Markdown.
			...(target.type === "group" ? { content: " " } : {}),
		});
	}

	/** Upload local bytes without sending an active/proactive QQ message. */
	async uploadMedia(
		target: QQReplyTarget,
		fileType: 1 | 4,
		fileData: string,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<QQMediaUploadResult> {
		const path = target.type === "private"
			? `/v2/users/${encodeURIComponent(target.userOpenId)}/files`
			: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/files`;
		const body = await this.postJson(path, {
			file_type: fileType,
			file_data: fileData,
			srv_send_msg: false,
		}, signal, timeoutMs, "media upload");
		if (typeof body.file_info !== "string" || !body.file_info) {
			throw new QQApiError("media upload response missing file_info", 502, undefined, true);
		}
		return {
			fileInfo: body.file_info,
			...(typeof body.file_uuid === "string" ? { fileUuid: body.file_uuid } : {}),
			ttl: typeof body.ttl === "number" && Number.isFinite(body.ttl) ? body.ttl : 0,
		};
	}

	/** Send previously uploaded media as a passive reply to the current QQ message. */
	async sendMedia(target: QQReplyTarget, fileInfo: string, msgSeq: number, signal?: AbortSignal): Promise<void> {
		await this.send(target, {
			msg_type: 7,
			media: { file_info: fileInfo },
			msg_id: target.msgId,
			msg_seq: msgSeq,
			...(target.type === "group" ? { content: " " } : {}),
		}, signal);
	}

	private async send(target: QQReplyTarget, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId)}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
		await this.postJson(path, payload, signal, 10_000, "send");
	}

	private async postJson(
		path: string,
		payload: Record<string, unknown>,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		operation: string,
	): Promise<Record<string, unknown>> {
		const token = await this.auth.getToken();
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `QQBot ${token}`,
				},
				body: JSON.stringify(payload),
				signal: requestSignal,
			});
		} catch (err) {
			throw new QQApiError(
				`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
				0,
			);
		}

		let body: Record<string, unknown> = {};
		try {
			body = (await res.json()) as Record<string, unknown>;
		} catch {
			// Successful sends may have no useful body; errors are still reported below.
		}
		if (res.ok) return body;

		const code = typeof body.code === "number" ? body.code : undefined;
		const message = typeof body.message === "string" ? body.message : "";
		throw new QQApiError(
			`${operation} failed (status ${res.status}${code != null ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
			res.status,
			code,
			true,
		);
	}
}
