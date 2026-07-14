/**
 * QQ Bot outbound passive-reply API for plain text and native Markdown.
 * A conservative maximum of four chunks is enforced by the router because QQ's
 * current documentation contains conflicting historical 4/5 reply limits.
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

	async sendMarkdown(target: QQReplyTarget, content: string, msgSeq: number): Promise<void> {
		await this.send(target, {
			markdown: { content },
			msg_type: 2,
			msg_id: target.msgId,
			msg_seq: msgSeq,
			// QQ documents group content as required even for Markdown.
			...(target.type === "group" ? { content: " " } : {}),
		});
	}

	private async send(target: QQReplyTarget, payload: Record<string, unknown>): Promise<void> {
		const path =
			target.type === "private"
				? `/v2/users/${encodeURIComponent(target.userOpenId)}/messages`
				: `/v2/groups/${encodeURIComponent(target.groupOpenId ?? "")}/messages`;
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
			true,
		);
	}
}
