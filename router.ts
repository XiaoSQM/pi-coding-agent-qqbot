/**
 * PiQQBotRuntime: wires the QQ gateway/api to the Pi agent.
 *
 * Responsibilities:
 *  - validate the allowlist for inbound messages
 *  - serialize QQ conversations through a single FIFO queue
 *  - run each message in the isolated QQ AgentSession
 *  - send the final assistant response back as a passive QQ reply
 *  - optionally mirror process-local events to the Pi TUI that ran /qqbot-start
 *
 * The observer is UI-only and optional. QQ handling never falls back to the
 * local Pi session, and observer failures never affect QQ replies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import { AttachmentPipeline, classifyAttachment } from "./attachment-pipeline";
import { maskAppId } from "./config";
import { QQApi, QQApiError } from "./qq-api";
import { QQAuth } from "./qq-auth";
import { QQGateway } from "./qq-gateway";
import { QQAgentSession, type QQAgentRunEvent, type QQToolCall } from "./qq-session";
import { MessageQueue } from "./queue";
import { formatQQReply, QQ_MAX_REPLY_CHUNKS } from "./reply-formatter";
import type {
	ConnectionState,
	PiQQBotConfig,
	QQConversationObserver,
	QQInboundMessage,
	PreparedAttachment,
	QQReplyTarget,
	QQTerminalEvent,
} from "./types";

const SUMMARY_MAX = 120;
const MAX_TRANSCRIPT_LINES = 6;

// pi slash commands that must NOT be run from QQ: they are local-session
// lifecycle/interactive commands with no meaning in the isolated QQ session.
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
	attachments: string[];
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
	private readonly config: PiQQBotConfig;

	private auth?: QQAuth;
	private gateway?: QQGateway;
	private api?: QQApi;
	private readonly queue: MessageQueue;
	private readonly attachmentPipeline: AttachmentPipeline;
	private readonly seenMessages = new MessageDedupe(2 * 60 * 60 * 1000, 2000);
	private qq?: QQAgentSession;
	private runtimeAbort = new AbortController();

	private ctx?: ExtensionContext;
	private running = false;
	private activeTarget?: QQReplyTarget;
	private activeFake = false;

	private state: ConnectionState = "disconnected";
	private stateDetail?: string;
	private lastError?: string;
	private lastAttachmentError?: string;
	private activeAttachmentStatus?: string;
	private lastInbound?: InboundSummary;
	private lastOutbound?: OutboundSummary;

	private pumpScheduled = false;
	private pumpTimer?: ReturnType<typeof setTimeout>;
	private fakeCounter = 0;
	private observer?: QQConversationObserver;

	constructor(config: PiQQBotConfig) {
		this.config = config;
		this.queue = new MessageQueue(config.maxQueueSize ?? 20);
		this.attachmentPipeline = new AttachmentPipeline(config, randomUUID());
	}

	attachObserver(observer: QQConversationObserver): void {
		this.observer = observer;
		this.emitRuntimeState();
	}

	detachObserver(observer?: QQConversationObserver): void {
		if (!observer || this.observer === observer) this.observer = undefined;
	}

	isReady(): boolean {
		return this.qq?.isReady() === true;
	}

	async start(ctx: ExtensionContext): Promise<boolean> {
		this.ctx = ctx;
		this.runtimeAbort = new AbortController();

		// Isolated QQ session first, so QQ traffic never touches the local session.
		const qq = new QQAgentSession();
		this.qq = qq;
		try {
			await qq.init(ctx.cwd);
		} catch (err) {
			if (this.qq === qq) this.qq = undefined;
			this.state = "error";
			this.stateDetail = "isolated session initialization failed";
			this.lastError = `qq session init failed: ${err instanceof Error ? err.message : String(err)}`;
			this.emit({ kind: "error", stage: "session init", message: this.lastError, at: Date.now() });
			this.emitRuntimeState();
			this.notify(`pi-qqbot: ${this.lastError}`, "error");
			return false; // without an isolated session we must not fall back to the local session
		}
		if (this.qq !== qq || !qq.isReady()) {
			if (this.qq === qq) this.qq = undefined;
			return false; // stopped while asynchronous initialization was in flight
		}

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
					this.emitRuntimeState();
					if (state === "connected") this.notify("pi-qqbot connected", "info");
					if (state === "error") this.notify(`pi-qqbot error: ${detail ?? ""}`, "error");
				},
				log: (m) => this.debugLog(m),
			},
		);
		await this.gateway.connect();
		return true;
	}

	async stop(): Promise<void> {
		this.runtimeAbort.abort(new Error("QQBot stopped"));
		await this.qq?.abort();
		if (this.pumpTimer) clearTimeout(this.pumpTimer);
		this.pumpTimer = undefined;
		this.pumpScheduled = false;
		this.gateway?.close();
		this.gateway = undefined;
		this.qq?.dispose();
		this.qq = undefined;
		this.queue.clear();
		this.activeTarget = undefined;
		this.activeFake = false;
		this.activeAttachmentStatus = undefined;
		this.running = false;
		this.state = "disconnected";
		this.stateDetail = undefined;
		this.emitRuntimeState();
	}

	async reconnect(): Promise<void> {
		if (!this.gateway) return;
		this.lastError = undefined;
		await this.gateway.reconnect();
	}

	// --- Agent run (isolated QQ session) ------------------------------------

	private async runOne(msg: QQInboundMessage): Promise<void> {
		if (!this.qq?.isReady()) {
			this.lastError = "qq session not ready";
			this.emit({ kind: "error", messageId: msg.id, stage: "agent run", message: this.lastError, at: Date.now() });
			return;
		}
		this.running = true;
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		this.activeTarget = target;
		this.activeFake = msg.fake === true;
		this.emit({ kind: "run_start", messageId: msg.id, at: Date.now() });
		this.emitRuntimeState();
		let prepared: Awaited<ReturnType<AttachmentPipeline["prepare"]>> | undefined;
		try {
			prepared = await this.attachmentPipeline.prepare(msg, this.runtimeAbort.signal, {
				onStart: (index, total, attachmentKind, filename) => {
					this.activeAttachmentStatus = `${attachmentKind} ${index}/${total}: ${filename}`;
					this.emit({ kind: "attachment_start", messageId: msg.id, index, total, attachmentKind, filename, at: Date.now() });
				},
				onProgress: (index, total, attachmentKind, filename, bytes) => {
					this.emit({ kind: "attachment_progress", messageId: msg.id, index, total, attachmentKind, filename, bytes, at: Date.now() });
				},
				onEnd: (index, total, resource, bytes) => {
					const note = resource.kind === "unsupported" ? resource.reason : resource.note;
					if (resource.status !== "ready") {
						this.lastAttachmentError = `${resource.errorCode ?? "attachment_failed"}: ${resource.filename}${note ? ` — ${note}` : ""}`;
					}
					this.emit({
						kind: resource.status === "ready" ? "attachment_end" : "attachment_rejected",
						messageId: msg.id,
						index,
						total,
						attachmentKind: resource.kind,
						filename: resource.filename,
						status: resource.status,
						bytes,
						note,
						at: Date.now(),
					});
				},
			});
			this.activeAttachmentStatus = undefined;

			const readyImages = prepared.resources.filter((resource) => resource.kind === "image" && resource.status === "ready");
			if (readyImages.length && !this.qq.supportsImages()) {
				const reply = msg.text.trim()
					? "当前 QQ Agent 使用的模型不支持图片理解。我没有读取图片；请切换到支持视觉输入的模型后重试。你的文字内容也未提交，以避免产生误导性回答。"
					: "当前 QQ Agent 使用的模型不支持图片理解，因此没有运行可能产生误导的模型回合。请切换到支持视觉输入的模型后重试。";
				await this.deliverReply(target, reply, this.activeFake);
				return;
			}

			if (!hasUsableAgentInput(msg, prepared.resources)) {
				await this.deliverReply(target, formatAttachmentFailures(prepared.resources), this.activeFake);
				return;
			}

			const { text, tools } = await this.qq.run(withQQReplyGuidance(prepared.prompt), prepared.images, (event) =>
				this.forwardAgentEvent(msg.id, event),
			);
			const body = this.config.showProcess
				? formatWithProcess(buildTranscript(tools), text)
				: text;
			if (body.trim()) {
				await this.deliverReply(target, body, this.activeFake);
			} else {
				this.debugLog("assistant produced no text; nothing to send");
			}
		} catch (err) {
			if (!this.runtimeAbort.signal.aborted) {
				this.lastError = `qq session run failed: ${err instanceof Error ? err.message : String(err)}`;
				this.emit({ kind: "error", messageId: msg.id, stage: "agent run", message: this.lastError, at: Date.now() });
				this.debugLog(this.lastError);
			}
		} finally {
			await prepared?.cleanup().catch(() => undefined);
			this.running = false;
			this.activeTarget = undefined;
			this.activeFake = false;
			this.activeAttachmentStatus = undefined;
			this.emit({ kind: "run_end", messageId: msg.id, at: Date.now() });
			this.emitRuntimeState();
			this.schedulePump();
		}
	}

	private forwardAgentEvent(messageId: string, event: QQAgentRunEvent): void {
		const at = Date.now();
		if (event.kind === "assistant_start") {
			this.emit({ kind: "assistant_start", messageId, at });
		} else if (event.kind === "assistant_delta") {
			this.emit({ kind: "assistant_delta", messageId, delta: event.delta, at });
		} else if (event.kind === "assistant_end") {
			this.emit({ kind: "assistant_end", messageId, at });
		} else if (event.kind === "tool_start") {
			this.emit({
				kind: "tool_start",
				messageId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				at,
			});
		} else {
			this.emit({
				kind: "tool_end",
				messageId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				at,
			});
		}
	}

	// --- Inbound -------------------------------------------------------------

	handleInbound(msg: QQInboundMessage): void {
		const allowed = msg.fake === true || isAllowed(this.config, msg);

		// Always record the sender so /qqbot-status and /qqbot-last can reveal the
		// openid even for unauthorized messages (needed to populate the allowlist).
		const attachmentSummary = msg.attachments.map(
			(attachment) => `${classifyAttachment(attachment)}:${sanitizeSummaryFilename(attachment.filename)}`,
		);
		this.lastInbound = {
			type: msg.type,
			user: msg.userOpenId,
			group: msg.groupOpenId,
			text: msg.text,
			attachments: attachmentSummary,
			at: msg.receivedAt,
			authorized: allowed,
		};

		if (!msg.text.trim() && msg.attachments.length === 0) {
			this.debugLog("ignored empty message");
			return;
		}
		if (!allowed) {
			this.debugLog(
				`ignored unauthorized ${msg.type} openid=${msg.type === "group" ? msg.groupOpenId : msg.userOpenId}`,
			);
			return;
		}

		if (!this.seenMessages.admit(msg.id, msg.receivedAt)) {
			this.debugLog(`ignored duplicate msg_id=${sanitizeLogValue(msg.id)}`);
			return;
		}

		const text = msg.text.trim();
		this.emit({
			kind: "inbound",
			messageId: msg.id,
			channel: msg.type,
			senderLabel: msg.type === "group" ? msg.groupOpenId ?? msg.userOpenId : msg.userOpenId,
			text,
			attachmentCount: msg.attachments.length,
			attachmentKinds: msg.attachments.map(classifyAttachment),
			fake: msg.fake === true,
			at: msg.receivedAt,
		});
		if (text.startsWith("/") && msg.attachments.length === 0) {
			this.handleCommand(msg, text);
			return;
		}
		this.enqueuePrompt(msg);
	}

	private enqueuePrompt(msg: QQInboundMessage): void {
		const accepted = this.queue.enqueue(msg);
		if (!accepted) {
			this.lastError = "queue full; message dropped";
			this.emit({ kind: "error", messageId: msg.id, stage: "queue", message: this.lastError, at: Date.now() });
			this.emitRuntimeState();
			this.debugLog(this.lastError);
			if (this.config.sendBusyNotice && !msg.fake) {
				void this.sendBusyNotice(msg);
			}
			return;
		}
		this.emit({ kind: "queued", messageId: msg.id, queueSize: this.queue.size, at: Date.now() });
		this.emitRuntimeState();
		this.schedulePump();
	}

	// --- Commands (treat the QQ chat like the pi input box) -----------------

	/**
	 * Handle a QQ message that starts with "/".
	 *  - /qqbot-status | /qqbot-last | /qqbot-help | /help -> answered to QQ.
	 *  - blocked local-session lifecycle commands -> refused.
	 *  - anything else -> run in the isolated QQ session as input (when
	 *    allowCommands), otherwise refused with a hint.
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
			void this.replyToQQ(msg, `\u547d\u4ee4 /${name} \u4e0d\u652f\u6301\u4ece QQ \u6267\u884c\uff08\u672c\u5730\u4f1a\u8bdd\u751f\u547d\u5468\u671f/\u4ea4\u4e92\u547d\u4ee4\uff09\u3002`);
			return;
		}
		if (!this.config.allowCommands) {
			void this.replyToQQ(msg, "\u547d\u4ee4\u672a\u5f00\u542f\u3002\u53d1 /qqbot-help \u770b\u53ef\u7528\u547d\u4ee4\u3002");
			return;
		}
		// Treat as input to the isolated QQ session (kept verbatim, including the "/").
		this.enqueuePrompt(msg);
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
			? "\n\u5176\u4ed6 / \u5f00\u5934\u7684\u8f93\u5165\u4f1a\u5728\u72ec\u7acb\u7684 QQ \u4f1a\u8bdd\u91cc\u5904\u7406\u3002\u76f4\u63a5\u53d1\u6587\u672c = \u5411 Pi \u63d0\u95ee\uff08\u72ec\u7acb\u4f1a\u8bdd\uff0c\u4e0d\u5f71\u54cd\u672c\u5730\uff09\u3002"
			: "\n\u76f4\u63a5\u53d1\u6587\u672c = \u5411 Pi \u63d0\u95ee\uff08\u72ec\u7acb\u4f1a\u8bdd\uff0c\u4e0d\u5f71\u54cd\u672c\u5730\uff09\u3002";
		return base + tail;
	}

	/** Simulate an inbound private message for local testing (/qqbot-fake). */
	simulateInbound(text: string): void {
		const msg: QQInboundMessage = {
			id: `fake-${Date.now()}-${++this.fakeCounter}`,
			type: "private",
			text,
			userOpenId: "FAKE_USER",
			attachments: [],
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
		this.pumpTimer = setTimeout(() => {
			this.pumpTimer = undefined;
			this.pumpScheduled = false;
			this.pump();
		}, 0);
	}

	private pump(): void {
		if (this.running) return; // a QQ run is in flight
		if (!this.qq?.isReady()) return; // isolated session not ready yet
		const msg = this.queue.dequeue();
		if (!msg) return;
		this.emitRuntimeState();
		void this.runOne(msg);
	}

	// --- Outbound ------------------------------------------------------------

	private async deliverReply(target: QQReplyTarget, text: string, fake: boolean): Promise<void> {
		const full = (this.config.replyPrefix ?? "") + text;
		const formatted = formatQQReply(full, this.config.replyFormat);
		const chunks = this.config.replyFormat === "plain" ? formatted.plain : formatted.markdown;

		this.lastOutbound = {
			type: target.type,
			user: target.userOpenId,
			group: target.groupOpenId,
			text: full,
			at: Date.now(),
			fake,
		};
		this.emit({
			kind: "reply_start",
			messageId: target.msgId,
			chunks: chunks.length,
			fake,
			at: Date.now(),
		});

		if (fake) {
			this.emit({
				kind: "reply_end",
				messageId: target.msgId,
				ok: true,
				sentChunks: chunks.length,
				at: Date.now(),
			});
			this.debugLog(`[fake] would send ${chunks.length} ${this.config.replyFormat === "plain" ? "plain" : "markdown"} chunk(s) to ${target.type}`);
			return;
		}
		if (!this.api) {
			const detail = "QQ API is not ready";
			this.emit({
				kind: "reply_end",
				messageId: target.msgId,
				ok: false,
				sentChunks: 0,
				error: detail,
				at: Date.now(),
			});
			return;
		}

		let sentChunks = 0;
		let nextMsgSeq = 1;
		let useMarkdown = this.config.replyFormat !== "plain";
		for (let i = 0; i < chunks.length && i < QQ_MAX_REPLY_CHUNKS; i++) {
			try {
				if (!useMarkdown) {
					await this.api.sendText(target, formatted.plain[i], nextMsgSeq++);
				} else {
					const fellBack = await this.sendMarkdownWithFallback(
						target,
						formatted.markdown[i],
						formatted.plain[i],
						nextMsgSeq,
					);
					nextMsgSeq += fellBack ? 2 : 1;
					if (fellBack) useMarkdown = false;
				}
				sentChunks++;
			} catch (err) {
				const detail = err instanceof QQApiError ? err.message : String(err);
				this.lastError = `send failed: ${detail}`;
				this.emit({
					kind: "reply_end",
					messageId: target.msgId,
					ok: false,
					sentChunks,
					error: detail,
					at: Date.now(),
				});
				this.debugLog(this.lastError);
				this.notify(`pi-qqbot send failed: ${detail}`, "error");
				return;
			}
		}
		this.emit({
			kind: "reply_end",
			messageId: target.msgId,
			ok: true,
			sentChunks,
			at: Date.now(),
		});
	}

	private async sendMarkdownWithFallback(
		target: QQReplyTarget,
		markdown: string,
		plain: string,
		msgSeq: number,
	): Promise<boolean> {
		if (!this.api) throw new Error("QQ API is not ready");
		try {
			await this.api.sendMarkdown(target, markdown, msgSeq);
			return false;
		} catch (err) {
			if (!(err instanceof QQApiError) || !canFallbackFromMarkdown(err)) throw err;
			this.debugLog(`markdown rejected; falling back to plain text (status ${err.status}${err.code != null ? `, code ${err.code}` : ""})`);
			// A rejected HTTP response did not deliver a QQ message. Use the next
			// sequence number and keep subsequent chunks plain for this reply.
			await this.api.sendText(target, plain, msgSeq + 1);
			return true;
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
			await this.api.sendText(target, "当前消息较多，请稍后重试。", 1);
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
			`session: isolated (${this.qq?.isReady() ? "ready" : "not ready"})`,
			`commands: ${this.config.allowCommands ? "on (isolated)" : "info-only"}`,
			`process: ${this.config.showProcess ? "on" : "off"}`,
			`reply format: ${this.config.replyFormat}`,
			`media: ${this.config.media.enabled ? "on" : "off"}`,
			`active: ${this.activeTargetLabel()}`,
			`attachment: ${this.activeAttachmentStatus ?? "idle"}`,
			`last inbound: ${this.lastInbound ? new Date(this.lastInbound.at).toLocaleTimeString() : "none"}`,
			`last outbound: ${this.lastOutbound ? new Date(this.lastOutbound.at).toLocaleTimeString() : "none"}`,
		];
		if (this.lastAttachmentError) lines.push(`last attachment error: ${this.lastAttachmentError}`);
		if (this.lastError) lines.push(`last error: ${this.lastError}`);
		return lines.join("\n");
	}

	lastSummary(): string {
		const lines: string[] = [];
		if (this.lastInbound) {
			const attachmentText = this.lastInbound.attachments.length
				? ` attachments=[${this.lastInbound.attachments.map(truncate).join(", ")}]`
				: "";
			lines.push(
				`last inbound: ${this.lastInbound.type} ${labelFor(this.lastInbound)}${this.lastInbound.authorized === false ? " (unauthorized — add to allowlist)" : ""} text="${truncate(this.lastInbound.text)}"${attachmentText}`,
			);
		}
		if (this.lastOutbound) {
			lines.push(
				`last outbound: ${this.lastOutbound.type}${this.lastOutbound.fake ? " (fake)" : ""} ${labelFor(this.lastOutbound)} text="${truncate(this.lastOutbound.text)}"`,
			);
		}
		if (this.lastAttachmentError) lines.push(`last attachment error: ${this.lastAttachmentError}`);
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

	private emit(event: QQTerminalEvent): void {
		try {
			this.observer?.onEvent(event);
		} catch {
			// A terminal view must never break QQ message handling.
		}
	}

	private emitRuntimeState(): void {
		this.emit({
			kind: "runtime_state",
			connection: this.state,
			detail: this.stateDetail,
			queueSize: this.queue.size,
			running: this.running,
			activeLabel: this.activeTarget
				? this.activeTarget.type === "group"
					? this.activeTarget.groupOpenId
					: this.activeTarget.userOpenId
				: undefined,
			at: Date.now(),
		});
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

function hasUsableAgentInput(msg: QQInboundMessage, resources: PreparedAttachment[]): boolean {
	if (msg.text.trim()) return true;
	return resources.some((resource) => resource.status === "ready");
}

function formatAttachmentFailures(resources: PreparedAttachment[]): string {
	const failures = resources.filter((resource) => resource.status !== "ready");
	if (!failures.length) return "没有可处理的文本或附件内容。";
	return failures
		.map((resource) => {
			const note = resource.kind === "unsupported" ? resource.reason : resource.note ?? "处理失败";
			return `${resource.filename}：${note}（${resource.errorCode ?? "attachment_failed"}）`;
		})
		.join("\n");
}

function sanitizeSummaryFilename(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").slice(0, 80) || "attachment";
}

function sanitizeLogValue(value: string): string {
	return value.replace(/[\r\n\t]/g, "_").slice(0, 120);
}

class MessageDedupe {
	private readonly entries = new Map<string, number>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
	) {}

	admit(id: string, now = Date.now()): boolean {
		for (const [key, expiry] of this.entries) {
			if (expiry > now) break;
			this.entries.delete(key);
		}
		const existing = this.entries.get(id);
		if (existing !== undefined && existing > now) return false;
		this.entries.delete(id);
		this.entries.set(id, now + this.ttlMs);
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		return true;
	}
}

function withQQReplyGuidance(prompt: string): string {
	return `${prompt}\n\n<qq-reply-guidance>\n以下要求仅约束最终回答的呈现，不改变用户任务本身：请为手机 QQ 聊天界面组织最终回答，先直接给出答案或结论，删除寒暄和“好问题”等填充语；短回答不要强加标题；普通回答按“结论 → 关键点或步骤 → 必要注意事项”组织。每段只表达一个主题，段落简短；并列信息用无序列表，操作流程用有序列表，列表不要超过两层。仅对关键字使用粗体，风险或限制使用带文字标签的引用块（如“⚠️ 注意”）。避免宽表格，优先改成列表；代码仅保留必要、可复制的片段。不要添加“执行过程”章节，插件会在需要时附加执行摘要。输出 QQ 支持的简洁 Markdown，不要为了装饰堆叠标题、分割线或 Emoji。\n</qq-reply-guidance>`;
}

function canFallbackFromMarkdown(err: QQApiError): boolean {
	if (!err.requestAccepted || err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500) return false;
	return /markdown|invalid request|not allowed|不允许|不支持/i.test(err.message) || err.status === 400;
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

/** Build the process transcript lines from the isolated session's tool calls. */
function buildTranscript(tools: QQToolCall[]): string[] {
	const lines: string[] = [];
	for (const t of tools) {
		if (lines.length >= MAX_TRANSCRIPT_LINES) break;
		lines.push(`- ${t.isError ? "❌" : "✅"} **${t.name}**：${argSummary(t.args) || (t.isError ? "执行失败" : "完成")}`);
	}
	if (tools.length > MAX_TRANSCRIPT_LINES) lines.push(`- 其余 ${tools.length - MAX_TRANSCRIPT_LINES} 项已省略`);
	return lines;
}

/** Keep the user-facing answer first; append only a compact execution summary. */
function formatWithProcess(transcript: string[], finalText: string): string {
	if (!transcript.length) return finalText;
	const answer = finalText.trim() || "（无文本回复）";
	return `${answer}\n\n***\n\n## 执行摘要\n\n${transcript.join("\n")}`;
}
