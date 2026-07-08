/**
 * PiQQBotRuntime: wires the QQ gateway/api to the Pi agent.
 *
 * Responsibilities:
 *  - validate the allowlist for inbound messages
 *  - convert QQ inbound events into Pi user messages (pi.sendUserMessage)
 *  - remember the reply target (msg_id) before injecting
 *  - capture the final assistant response on agent_end and send it back to QQ
 *    as a passive reply (msg_id + msg_seq)
 *  - serialize QQ conversations through a single FIFO queue so replies are not
 *    misrouted while Pi processes one turn at a time
 *
 * Delivery model: a queued QQ message is only injected while Pi is idle (no
 * active turn). This keeps each injected message on its own turn, so the
 * following agent_end unambiguously belongs to that QQ conversation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { maskAppId, type PiQQBotConfig } from "./config";
import { QQApi, QQApiError } from "./qq-api";
import { QQAuth } from "./qq-auth";
import { QQGateway } from "./qq-gateway";
import { MessageQueue } from "./queue";
import type { ConnectionState, QQInboundMessage, QQReplyTarget } from "./types";

const CHUNK_SIZE = 800;
const MAX_CHUNKS = 5; // hard cap of 5 passive replies per msg_id
const SUMMARY_MAX = 120;
const MAX_TRANSCRIPT_LINES = 50;

// pi slash commands that must NOT be triggered from QQ: they tear down the
// session (killing the in-flight QQ reply) or require local TUI interaction.
const BLOCKED_COMMANDS = new Set([
	"new",
	"resume",
	"fork",
	"clone",
	"reload",
	"quit",
	"exit",
	"clear",
	"compact",
	"tree",
	"model",
	"login",
	"logout",
	"theme",
	"redo",
	"undo",
]);

interface InboundSummary {
	type: "private" | "group";
	user: string;
	group?: string;
	text: string;
	at: number;
	authorized?: boolean;
}

interface OutboundSummary {
	type: "private" | "group";
	user: string;
	group?: string;
	text: string;
	at: number;
	fake?: boolean;
}

export class PiQQBotRuntime {
	private readonly pi: ExtensionAPI;
	private readonly config: PiQQBotConfig;

	private auth?: QQAuth;
	private gateway?: QQGateway;
	private api?: QQApi;
	private readonly queue: MessageQueue;

	private ctx?: ExtensionContext;
	private busy = false;
	private activeTarget?: QQReplyTarget;
	private activeFake = false;
	private transcript: string[] = [];

	private state: ConnectionState = "disconnected";
	private stateDetail?: string;
	private lastError?: string;
	private lastInbound?: InboundSummary;
	private lastOutbound?: OutboundSummary;

	private pumpScheduled = false;
	private fakeCounter = 0;

	constructor(pi: ExtensionAPI, config: PiQQBotConfig) {
		this.pi = pi;
		this.config = config;
		this.queue = new MessageQueue(config.maxQueueSize ?? 20);
	}

	async start(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.auth = new QQAuth(this.config.appId, this.config.clientSecret);
		this.api = new QQApi(this.auth, { sandbox: this.config.sandbox ?? true });
		this.gateway = new QQGateway(
			this.auth,
			{ sandbox: this.config.sandbox ?? true },
			{
				onInbound: (msg) => this.handleInbound(msg),
				onState: (state, detail) => {
					this.state = state;
					this.stateDetail = detail;
					if (state === "error" && detail) this.lastError = detail;
					if (state === "connected") this.notify("pi-qqbot connected", "info");
					if (state === "error") this.notify(`pi-qqbot error: ${detail ?? ""}`, "error");
				},
				log: (m) => this.debugLog(m),
			},
		);
		await this.gateway.connect();
	}

	async stop(): Promise<void> {
		this.gateway?.close();
		this.gateway = undefined;
		this.queue.clear();
		this.activeTarget = undefined;
		this.activeFake = false;
		this.busy = false;
		this.state = "disconnected";
	}

	async reconnect(): Promise<void> {
		if (!this.gateway) return;
		this.lastError = undefined;
		await this.gateway.reconnect();
	}

	// --- Agent lifecycle -----------------------------------------------------

	handleAgentStart(): void {
		this.busy = true;
	}

	/** Record a tool call into the current QQ turn's process transcript. */
	recordToolStart(toolName: string, args: unknown): void {
		if (!this.activeTarget || !this.config.showProcess) return;
		if (this.transcript.length >= MAX_TRANSCRIPT_LINES) {
			if (this.transcript[this.transcript.length - 1] !== "…") this.transcript.push("…");
			return;
		}
		this.transcript.push(`${toolName}: ${argSummary(args)}`);
	}

	recordToolEnd(_toolName: string, isError: boolean): void {
		if (!this.activeTarget || !this.config.showProcess) return;
		const last = this.transcript.length - 1;
		if (last >= 0 && this.transcript[last] !== "…") {
			this.transcript[last] += isError ? " \u274c" : " \u2713";
		}
	}

	async handleAgentEnd(event: { messages?: unknown[] }, ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.busy = false;

		const target = this.activeTarget;
		const fake = this.activeFake;
		if (target) {
			this.activeTarget = undefined;
			this.activeFake = false;
			const transcript = this.transcript;
			this.transcript = [];
			const finalText = extractFinalAssistantText(event.messages ?? []);
			const body = this.config.showProcess ? formatWithProcess(transcript, finalText) : finalText;
			if (body.trim()) {
				await this.deliverReply(target, body, fake);
			} else {
				this.debugLog("assistant produced no text; nothing to send");
			}
		} else {
			this.transcript = [];
		}

		this.schedulePump();
	}

	// --- Inbound -------------------------------------------------------------

	handleInbound(msg: QQInboundMessage): void {
		const allowed = msg.fake === true || isAllowed(this.config, msg);

		// Always record the sender so /qqbot-status and /qqbot-last can reveal the
		// openid even for unauthorized messages (needed to populate the allowlist).
		this.lastInbound = {
			type: msg.type,
			user: msg.userOpenId,
			group: msg.groupOpenId,
			text: msg.text,
			at: msg.receivedAt,
			authorized: allowed,
		};

		if (!msg.text.trim()) {
			this.debugLog("ignored empty message");
			return;
		}
		if (!allowed) {
			this.debugLog(
				`ignored unauthorized ${msg.type} openid=${msg.type === "group" ? msg.groupOpenId : msg.userOpenId}`,
			);
			return;
		}

		const text = msg.text.trim();
		if (text.startsWith("/")) {
			this.handleCommand(msg, text);
			return;
		}
		this.enqueuePrompt(msg);
	}

	private enqueuePrompt(msg: QQInboundMessage): void {
		const accepted = this.queue.enqueue(msg);
		if (!accepted) {
			this.lastError = "queue full; message dropped";
			this.debugLog(this.lastError);
			if (this.config.sendBusyNotice && !msg.fake) {
				void this.sendBusyNotice(msg);
			}
			return;
		}
		this.schedulePump();
	}

	// --- Commands (treat the QQ chat like the pi input box) -----------------

	/**
	 * Handle a QQ message that starts with "/".
	 *  - /qqbot-status | /qqbot-last | /qqbot-help | /help -> answered to QQ.
	 *  - blocked lifecycle/interactive commands -> refused.
	 *  - other known commands -> forwarded to pi (fire-and-forget) if allowCommands.
	 *  - unknown "/..." -> treated as a normal prompt.
	 */
	private handleCommand(msg: QQInboundMessage, text: string): void {
		const name = text.slice(1).split(/\s+/)[0].toLowerCase();

		if (name === "qqbot-status") {
			void this.replyToQQ(msg, this.statusText());
			return;
		}
		if (name === "qqbot-last") {
			void this.replyToQQ(msg, this.lastSummary());
			return;
		}
		if (name === "qqbot-help" || name === "help") {
			void this.replyToQQ(msg, this.helpText());
			return;
		}
		if (BLOCKED_COMMANDS.has(name)) {
			void this.replyToQQ(msg, `\u547d\u4ee4 /${name} \u4e0d\u80fd\u4ece QQ \u6267\u884c\uff08\u4f1a\u5f71\u54cd\u4f1a\u8bdd\u6216\u9700\u8981\u672c\u5730\u4ea4\u4e92\uff09\u3002`);
			return;
		}
		if (!this.config.allowCommands) {
			void this.replyToQQ(msg, "\u547d\u4ee4\u8f6c\u53d1\u672a\u5f00\u542f\u3002\u53d1 /qqbot-help \u770b\u53ef\u7528\u547d\u4ee4\u3002");
			return;
		}
		if (!this.knownCommand(name)) {
			// Not a real command; treat it as a normal prompt so the reply is captured.
			this.enqueuePrompt(msg);
			return;
		}
		this.forwardCommand(text);
		void this.replyToQQ(msg, `\u5df2\u5728\u672c\u5730 pi \u6267\u884c /${name}\uff08\u8f93\u51fa\u663e\u793a\u5728\u672c\u5730\u754c\u9762\uff0c\u4e0d\u56de\u4f20 QQ\uff09\u3002`);
	}

	private knownCommand(name: string): boolean {
		try {
			return this.pi.getCommands().some((c) => c.name === name);
		} catch {
			return false;
		}
	}

	private forwardCommand(text: string): void {
		try {
			if (this.busy) this.pi.sendUserMessage(text, { deliverAs: "followUp" });
			else this.pi.sendUserMessage(text);
		} catch {
			try {
				this.pi.sendUserMessage(text, { deliverAs: "followUp" });
			} catch (err) {
				this.lastError = `forward failed: ${err instanceof Error ? err.message : String(err)}`;
				this.debugLog(this.lastError);
			}
		}
	}

	private async replyToQQ(msg: QQInboundMessage, text: string): Promise<void> {
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		await this.deliverReply(target, text, msg.fake === true);
	}

	private helpText(): string {
		const base =
			"QQ \u53ef\u7528\u547d\u4ee4\uff1a\n/qqbot-status \u72b6\u6001\n/qqbot-last \u6700\u8fd1\u6d88\u606f\n/qqbot-help \u5e2e\u52a9";
		const tail = this.config.allowCommands
			? "\n\u5176\u4ed6 pi \u659c\u6760\u547d\u4ee4\u4f1a\u5728\u672c\u5730\u6267\u884c\uff08\u8f93\u51fa\u4e0d\u56de\u4f20\uff09\u3002\u76f4\u63a5\u53d1\u6587\u672c = \u5411 Pi \u63d0\u95ee\u3002"
			: "\n\u547d\u4ee4\u8f6c\u53d1\u5df2\u5173\u95ed\u3002\u76f4\u63a5\u53d1\u6587\u672c = \u5411 Pi \u63d0\u95ee\u3002";
		return base + tail;
	}

	/** Simulate an inbound private message for local testing (/qqbot-fake). */
	simulateInbound(text: string): void {
		const msg: QQInboundMessage = {
			id: `fake-${Date.now()}-${++this.fakeCounter}`,
			type: "private",
			text,
			userOpenId: "FAKE_USER",
			raw: { fake: true },
			receivedAt: Date.now(),
			fake: true,
		};
		this.handleInbound(msg);
	}

	// --- Queue pump ----------------------------------------------------------

	private schedulePump(): void {
		if (this.pumpScheduled) return;
		this.pumpScheduled = true;
		setTimeout(() => {
			this.pumpScheduled = false;
			this.pump();
		}, 0);
	}

	private pump(): void {
		if (this.activeTarget) return; // a QQ turn is in flight
		if (this.busy) return; // Pi is busy (local or another turn); wait
		const msg = this.queue.dequeue();
		if (!msg) return;

		this.activeTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		this.activeFake = msg.fake === true;
		this.transcript = [];

		const prompt = buildPrompt(msg);
		this.safeInject(prompt);
	}

	private safeInject(prompt: string): void {
		try {
			this.pi.sendUserMessage(prompt);
		} catch {
			// Agent still finalizing: queue as follow-up (delivered on next idle).
			try {
				this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			} catch (err) {
				this.lastError = `inject failed: ${err instanceof Error ? err.message : String(err)}`;
				this.debugLog(this.lastError);
				this.activeTarget = undefined;
				this.activeFake = false;
			}
		}
	}

	// --- Outbound ------------------------------------------------------------

	private async deliverReply(target: QQReplyTarget, text: string, fake: boolean): Promise<void> {
		const full = (this.config.replyPrefix ?? "") + text;
		const chunks = splitChunks(full);

		this.lastOutbound = {
			type: target.type,
			user: target.userOpenId,
			group: target.groupOpenId,
			text: full,
			at: Date.now(),
			fake,
		};

		if (fake) {
			this.debugLog(`[fake] would send ${chunks.length} chunk(s) to ${target.type}`);
			return;
		}
		if (!this.api) return;

		for (let i = 0; i < chunks.length; i++) {
			try {
				await this.api.sendText(target, chunks[i], i + 1);
			} catch (err) {
				const detail = err instanceof QQApiError ? err.message : String(err);
				this.lastError = `send failed: ${detail}`;
				this.debugLog(this.lastError);
				this.notify(`pi-qqbot send failed: ${detail}`, "error");
				break; // stop; passive-reply window/cap likely exceeded
			}
		}
	}

	private async sendBusyNotice(msg: QQInboundMessage): Promise<void> {
		if (!this.api) return;
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		try {
			await this.api.sendText(target, "Busy right now, please try again shortly.", 1);
		} catch (err) {
			this.debugLog(`busy notice failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// --- Status / debug ------------------------------------------------------

	statusText(): string {
		const lines = [
			`pi-qqbot: ${this.config.enabled ? "enabled" : "disabled"} (appId ${maskAppId(this.config.appId)}, ${this.config.sandbox ? "sandbox" : "prod"})`,
			`connection: ${this.state}${this.stateDetail ? ` (${this.stateDetail})` : ""}`,
			`queue: ${this.queue.size}`,
			`commands: ${this.config.allowCommands ? "forwarding on" : "info-only"}`,
			`process: ${this.config.showProcess ? "on" : "off"}`,
			`active: ${this.activeTargetLabel()}`,
			`last inbound: ${this.lastInbound ? new Date(this.lastInbound.at).toLocaleTimeString() : "none"}`,
			`last outbound: ${this.lastOutbound ? new Date(this.lastOutbound.at).toLocaleTimeString() : "none"}`,
		];
		if (this.lastError) lines.push(`last error: ${this.lastError}`);
		return lines.join("\n");
	}

	lastSummary(): string {
		const lines: string[] = [];
		if (this.lastInbound) {
			lines.push(
				`last inbound: ${this.lastInbound.type} ${labelFor(this.lastInbound)}${this.lastInbound.authorized === false ? " (unauthorized — add to allowlist)" : ""} text="${truncate(this.lastInbound.text)}"`,
			);
		}
		if (this.lastOutbound) {
			lines.push(
				`last outbound: ${this.lastOutbound.type}${this.lastOutbound.fake ? " (fake)" : ""} ${labelFor(this.lastOutbound)} text="${truncate(this.lastOutbound.text)}"`,
			);
		}
		if (this.lastError) lines.push(`last error: ${this.lastError}`);
		return lines.length ? lines.join("\n") : "no QQBot events yet";
	}

	private activeTargetLabel(): string {
		if (!this.activeTarget) return "none";
		return this.activeTarget.type === "group"
			? `group:${this.activeTarget.groupOpenId}`
			: `private:${this.activeTarget.userOpenId}`;
	}

	private notify(text: string, level: "info" | "warning" | "error"): void {
		if (this.ctx?.hasUI) this.ctx.ui.notify(text, level);
	}

	private debugLog(msg: string): void {
		if (this.config.debug) this.notify(`[qqbot] ${msg}`, "info");
	}
}

// --- helpers ---------------------------------------------------------------

export function isAllowed(config: PiQQBotConfig, msg: QQInboundMessage): boolean {
	if (msg.type === "private") {
		return (config.allowUsers ?? []).includes(msg.userOpenId);
	}
	if (msg.type === "group") {
		return (config.allowGroups ?? []).includes(msg.groupOpenId ?? "");
	}
	return false;
}

function buildPrompt(msg: QQInboundMessage): string {
	if (msg.type === "private") {
		return `[QQ private user=${msg.userOpenId} message=${msg.id}]\n${msg.text}`;
	}
	return `[QQ group=${msg.groupOpenId} user=${msg.userOpenId} message=${msg.id}]\n${msg.text}`;
}

/**
 * Scan from the end of the messages for the last assistant message that has
 * text content. Handles both string content and content-part arrays.
 */
export function extractFinalAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown } | undefined;
		if (!m || m.role !== "assistant") continue;
		const text = extractText(m.content);
		if (text.trim()) return text;
	}
	return "";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(p): p is { type: string; text: string } =>
					!!p && typeof p === "object" && (p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string",
			)
			.map((p) => p.text)
			.join("");
	}
	return "";
}

function splitChunks(text: string): string[] {
	if (text.length <= CHUNK_SIZE) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
		chunks.push(text.slice(i, i + CHUNK_SIZE));
	}
	const consumed = chunks.length * CHUNK_SIZE;
	if (consumed < text.length && chunks.length > 0) {
		chunks[chunks.length - 1] = `${chunks[chunks.length - 1].slice(0, CHUNK_SIZE - 1)}…`;
	}
	return chunks;
}

function truncate(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine;
}

function labelFor(s: InboundSummary | OutboundSummary): string {
	return s.type === "group" ? `group=${s.group}` : `user=${s.user}`;
}

/** Short one-line summary of a tool call's key argument. */
function argSummary(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = a.command ?? a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query ?? a.url;
	let s = typeof pick === "string" ? pick : JSON.stringify(a);
	s = (s ?? "").replace(/\s+/g, " ").trim();
	return s.length > 100 ? `${s.slice(0, 100)}\u2026` : s;
}

/** Combine a tool-call transcript with the final answer for the QQ reply. */
function formatWithProcess(transcript: string[], finalText: string): string {
	if (!transcript.length) return finalText;
	const lines = transcript.map((l, i) => (l === "\u2026" ? "\u2026" : `${i + 1}. ${l}`)).join("\n");
	const header = `\u{1f527} \u6267\u884c\u8fc7\u7a0b:\n${lines}`;
	const sep = "\n\u2014\u2014 \u56de\u590d \u2014\u2014\n";
	return `${header}${sep}${finalText || "(\u65e0\u6587\u672c\u56de\u590d)"}`;
}
