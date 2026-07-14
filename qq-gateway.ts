/**
 * QQ Bot gateway WebSocket client.
 *
 * Protocol reference: QQ 机器人官方文档 - 使用 Websocket 接入
 *   1. GET {base}/gateway -> { url }  (header: Authorization: QQBot {token})
 *   2. Receive OpCode 10 Hello -> { heartbeat_interval }
 *   3. Send OpCode 2 Identify -> { token: "QQBot {access_token}", intents, shard, properties }
 *      (or OpCode 6 Resume with session_id + seq when reconnecting)
 *   4. Send OpCode 1 Heartbeat every interval, d = last seq (null on first)
 *   5. Receive OpCode 11 Heartbeat ACK
 *   6. Receive OpCode 0 Dispatch (t, d, s) -> events
 *
 * Intents: GROUP_AND_C2C_EVENT = 1 << 25 covers C2C_MESSAGE_CREATE and
 * GROUP_AT_MESSAGE_CREATE, which is all the MVP needs.
 */

import { WebSocket } from "ws";

import type { QQAuth } from "./qq-auth";
import type { ConnectionState, QQAttachment, QQInboundMessage } from "./types";

const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";

const INTENT_GROUP_AND_C2C = 1 << 25;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const MAX_BACKOFF_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5; // then give up until a manual /qqbot-reconnect

export interface QQGatewayCallbacks {
	onInbound: (msg: QQInboundMessage) => void;
	onState: (state: ConnectionState, detail?: string) => void;
	log: (msg: string) => void;
}

interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number;
	t?: string;
}

export class QQGateway {
	private readonly auth: QQAuth;
	private readonly base: string;
	private readonly cb: QQGatewayCallbacks;

	private ws?: WebSocket;
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private lastSeq: number | null = null;
	private sessionId?: string;
	private backoffMs = 1000;
	private reconnectAttempts = 0;
	private closing = false;

	constructor(auth: QQAuth, opts: { sandbox: boolean }, cb: QQGatewayCallbacks) {
		this.auth = auth;
		this.base = opts.sandbox ? SANDBOX_BASE : PROD_BASE;
		this.cb = cb;
	}

	async connect(): Promise<void> {
		this.closing = false;
		await this.openSocket();
	}

	/** Close the connection and stop reconnecting. */
	close(): void {
		this.closing = true;
		this.clearTimers();
		if (this.ws) {
			try {
				this.ws.removeAllListeners();
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = undefined;
		}
		this.cb.onState("disconnected");
	}

	/** Force a full reconnect (fresh session). */
	async reconnect(): Promise<void> {
		this.sessionId = undefined;
		this.lastSeq = null;
		this.closing = false;
		this.backoffMs = 1000;
		this.reconnectAttempts = 0;
		this.clearTimers();
		if (this.ws) {
			try {
				this.ws.removeAllListeners();
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = undefined;
		}
		await this.openSocket();
	}

	private clearTimers(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private async openSocket(): Promise<void> {
		this.cb.onState("connecting");
		let gatewayUrl: string;
		try {
			gatewayUrl = await this.fetchGatewayUrl();
		} catch (err) {
			this.cb.onState("error", err instanceof Error ? err.message : String(err));
			this.scheduleReconnect();
			return;
		}

		const ws = new WebSocket(gatewayUrl);
		this.ws = ws;

		ws.on("open", () => {
			this.cb.log("gateway socket open");
		});

		ws.on("message", (data: Buffer) => {
			this.handleRaw(data.toString());
		});

		ws.on("error", (err: Error) => {
			this.cb.log(`gateway error: ${err.message}`);
			this.cb.onState("error", err.message);
		});

		ws.on("close", (code: number) => {
			this.cb.log(`gateway closed (code ${code})`);
			this.clearTimers();
			if (!this.closing) {
				this.cb.onState("disconnected", `closed (${code})`);
				this.scheduleReconnect();
			}
		});
	}

	private async fetchGatewayUrl(): Promise<string> {
		const token = await this.auth.getToken();
		const res = await fetch(`${this.base}/gateway`, {
			headers: { Authorization: `QQBot ${token}` },
		});
		if (!res.ok) {
			throw new Error(`gateway lookup failed (status ${res.status})`);
		}
		const body = (await res.json()) as { url?: string };
		if (!body.url) throw new Error("gateway lookup returned no url");
		return body.url;
	}

	private scheduleReconnect(): void {
		if (this.closing) return;
		if (this.reconnectTimer) return;
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this.closing = true; // stop the loop; require a manual reconnect
			this.cb.onState(
				"error",
				`gave up after ${MAX_RECONNECT_ATTEMPTS} attempts; use /qqbot-reconnect to retry`,
			);
			this.cb.log("gave up reconnecting; use /qqbot-reconnect");
			return;
		}
		this.reconnectAttempts++;
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
		this.cb.log(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.openSocket();
		}, delay);
	}

	private handleRaw(raw: string): void {
		let payload: GatewayPayload;
		try {
			payload = JSON.parse(raw) as GatewayPayload;
		} catch {
			this.cb.log("received non-JSON gateway frame");
			return;
		}

		if (typeof payload.s === "number") this.lastSeq = payload.s;

		switch (payload.op) {
			case OP_HELLO:
				this.onHello(payload.d as { heartbeat_interval?: number });
				break;
			case OP_HEARTBEAT_ACK:
				break;
			case OP_DISPATCH:
				this.onDispatch(payload);
				break;
			case OP_RECONNECT:
				this.cb.log("gateway requested reconnect");
				this.reconnectSoft();
				break;
			case OP_INVALID_SESSION:
				this.cb.log("gateway reported invalid session");
				this.sessionId = undefined;
				this.lastSeq = null;
				this.reconnectSoft();
				break;
			default:
				break;
		}
	}

	private reconnectSoft(): void {
		this.clearTimers();
		if (this.ws) {
			try {
				this.ws.removeAllListeners();
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = undefined;
		}
		this.scheduleReconnect();
	}

	private onHello(d: { heartbeat_interval?: number } | undefined): void {
		const interval = d?.heartbeat_interval ?? 45000;
		this.clearHeartbeat();
		this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
		// Authenticate: resume if we have a session, otherwise identify.
		if (this.sessionId && this.lastSeq != null) {
			void this.sendResume();
		} else {
			void this.sendIdentify();
		}
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private sendHeartbeat(): void {
		this.send({ op: OP_HEARTBEAT, d: this.lastSeq });
	}

	private async sendIdentify(): Promise<void> {
		let token: string;
		try {
			token = await this.auth.getToken();
		} catch (err) {
			this.cb.onState("error", err instanceof Error ? err.message : String(err));
			return;
		}
		this.send({
			op: OP_IDENTIFY,
			d: {
				token: `QQBot ${token}`,
				intents: INTENT_GROUP_AND_C2C,
				shard: [0, 1],
				properties: {},
			},
		});
	}

	private async sendResume(): Promise<void> {
		let token: string;
		try {
			token = await this.auth.getToken();
		} catch (err) {
			this.cb.onState("error", err instanceof Error ? err.message : String(err));
			return;
		}
		this.send({
			op: OP_RESUME,
			d: {
				token: `QQBot ${token}`,
				session_id: this.sessionId,
				seq: this.lastSeq,
			},
		});
	}

	private onDispatch(payload: GatewayPayload): void {
		const t = payload.t;
		if (t === "READY") {
			const d = payload.d as { session_id?: string } | undefined;
			this.sessionId = d?.session_id;
			this.backoffMs = 1000; // reset backoff on success
			this.reconnectAttempts = 0;
			this.cb.onState("connected");
			this.cb.log("gateway READY");
			return;
		}
		if (t === "RESUMED") {
			this.backoffMs = 1000;
			this.reconnectAttempts = 0;
			this.cb.onState("connected");
			this.cb.log("gateway RESUMED");
			return;
		}

		if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE") {
			const msg = this.normalize(t, payload.d);
			if (msg) this.cb.onInbound(msg);
		}
	}

	private normalize(t: string, d: unknown): QQInboundMessage | undefined {
		const data = d as {
			id?: string;
			content?: string;
			group_openid?: string;
			author?: { user_openid?: string; member_openid?: string };
			attachments?: unknown;
		};
		if (!data || typeof data.id !== "string") return undefined;

		const text = typeof data.content === "string" ? data.content.trim() : "";
		const attachments = normalizeAttachments(data.attachments);
		if (t === "C2C_MESSAGE_CREATE") {
			const userOpenId = data.author?.user_openid;
			if (!userOpenId) return undefined;
			return {
				id: data.id,
				type: "private",
				text,
				userOpenId,
				attachments,
				raw: d,
				receivedAt: Date.now(),
			};
		}
		// GROUP_AT_MESSAGE_CREATE
		const memberOpenId = data.author?.member_openid ?? "";
		if (!data.group_openid) return undefined;
		return {
			id: data.id,
			type: "group",
			text,
			userOpenId: memberOpenId,
			groupOpenId: data.group_openid,
			attachments,
			raw: d,
			receivedAt: Date.now(),
		};
	}

	private send(payload: GatewayPayload): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (err) {
				this.cb.log(`send failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}

function normalizeAttachments(value: unknown): QQAttachment[] {
	if (!Array.isArray(value)) return [];
	const result: QQAttachment[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		const contentType = stringField(raw.content_type);
		const filename = stringField(raw.filename) || defaultFilename(contentType, result.length + 1);
		const size = numberField(raw.size);
		const width = numberField(raw.width);
		const height = numberField(raw.height);
		const url = normalizeQQUrl(raw.url);
		const voiceWavUrl = normalizeQQUrl(raw.voice_wav_url);
		const asrReferText = stringField(raw.asr_refer_text);
		result.push({
			contentType,
			filename,
			...(size !== undefined ? { size } : {}),
			...(width !== undefined ? { width } : {}),
			...(height !== undefined ? { height } : {}),
			...(url ? { url } : {}),
			...(voiceWavUrl ? { voiceWavUrl } : {}),
			...(asrReferText ? { asrReferText } : {}),
		});
	}
	return result;
}

function normalizeQQUrl(value: unknown): string | undefined {
	const url = stringField(value);
	if (!url) return undefined;
	return url.startsWith("//") ? `https:${url}` : url;
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function defaultFilename(contentType: string, index: number): string {
	if (contentType.startsWith("image/")) return `image-${index}`;
	if (contentType === "voice" || contentType.startsWith("audio/")) return `voice-${index}`;
	return `attachment-${index}`;
}
