/**
 * QQ Bot outbound message API (text only for the MVP).
 *
 * Protocol reference: QQ 机器人官方文档 - 发送消息
 *   C2C:   POST {base}/v2/users/{openid}/messages
 *   Group: POST {base}/v2/groups/{group_openid}/messages
 *   body:  { content, msg_type: 0, msg_id, msg_seq }
 *   header: Authorization: QQBot {access_token}
 *
 * Passive-reply constraints (see plan section 12): a reply MUST include the
 * original msg_id, and it must be sent inside the window (C2C 60min, group
 * 5min), max 5 replies per msg_id. Active push is not a usable fallback.
 */

import type { QQAuth } from "./qq-auth";
import type { QQReplyTarget } from "./types";

const PROD_BASE = "https://api.sgroup.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";

export interface QQApiOptions {
	sandbox: boolean;
}

export class QQApiError extends Error {
	readonly status: number;
	readonly code?: number;
	constructor(message: string, status: number, code?: number) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class QQApi {
	private readonly auth: QQAuth;
	private readonly base: string;

	constructor(auth: QQAuth, opts: QQApiOptions) {
		this.auth = auth;
		this.base = opts.sandbox ? SANDBOX_BASE : PROD_BASE;
	}

	/**
	 * Send a single text message as a passive reply to `target`.
	 * `msgSeq` must be unique per msg_id (start at 1, increment per chunk).
	 */
	async sendText(target: QQReplyTarget, content: string, msgSeq: number): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId)}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;

		const payload = {
			content,
			msg_type: 0,
			msg_id: target.msgId,
			msg_seq: msgSeq,
		};

		const token = await this.auth.getToken();

		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `QQBot ${token}`,
				},
				body: JSON.stringify(payload),
			});
		} catch (err) {
			throw new QQApiError(
				`send request failed: ${err instanceof Error ? err.message : String(err)}`,
				0,
			);
		}

		if (res.ok) return;

		// Non-2xx: surface the platform error code/message without leaking secrets.
		let code: number | undefined;
		let message = "";
		try {
			const body = (await res.json()) as { code?: number; message?: string };
			code = body.code;
			message = body.message ?? "";
		} catch {
			// ignore parse errors
		}
		throw new QQApiError(
			`send failed (status ${res.status}${code != null ? `, code ${code}` : ""})${message ? `: ${message}` : ""}`,
			res.status,
			code,
		);
	}
}
