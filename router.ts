/**
 * PiQQBotRuntime: wires the QQ gateway/api to the Pi agent.
 *
 * Responsibilities:
 *  - validate the allowlist for inbound messages
 *  - serialize different QQ conversations through a FIFO queue
 *  - steer new messages from the active conversation into its AgentSession run
 *  - send the aggregate final assistant response back as a passive QQ reply
 *  - optionally mirror process-local events to the Pi TUI that ran /qqbot-start
 *
 * The observer is UI-only and optional. QQ handling never falls back to the
 * local Pi session, and observer failures never affect QQ replies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { authorizeQQCommand, QQ_COMMAND_NAMES, QQ_REMOTE_BLOCKED_COMMANDS } from "./command-controller";
import { normalizeCommandText, parseQQCommand, type ParsedQQCommand } from "./command-parser";
import { ConversationRegistry, conversationKey } from "./conversation-registry";
import { formatUserFacingAgentError, humanizeSessionPreview } from "./user-facing";

import { QQAccessRequestStore, type QQAccessRequest } from "./access-requests";
import { AttachmentPipeline, classifyAttachment } from "./attachment-pipeline";
import { maskAppId } from "./config";
import { buildModelPage, formatModelPageFallback, type ModelPage } from "./model-pages";
import { QQApi, QQApiError } from "./qq-api";
import { QQAuth } from "./qq-auth";
import { QQGateway } from "./qq-gateway";
import { normalizeThinkingLevel, type QQAgentRunEvent, type QQAgentSession, type QQModelInfo, type QQSessionInfo, type QQToolCall, resolveSdkEntry } from "./qq-session";
import { buildCommandKeyboard, type QQCommandButton } from "./qq-keyboard";
import { MessageQueue } from "./queue";
import { QQOutboundDeliveryContext } from "./outbound-media";
import { formatQQReply, QQ_MAX_REPLY_CHUNKS } from "./reply-formatter";
import type {
	ConnectionState,
	PiQQBotConfig,
	QQConversationObserver,
	QQInboundMessage,
	QQKeyboard,
	PreparedAttachment,
	PreparedQQMessage,
	QQOutboundDeliveryRecord,
	QQReplyTarget,
	QQTerminalEvent,
} from "./types";

const SUMMARY_MAX = 120;
const MAX_TRANSCRIPT_LINES = 6;

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

interface ActiveConversationInput {
	msg: QQInboundMessage;
	target: QQReplyTarget;
	pendingSlot: boolean;
	pendingReleased: boolean;
	prepared?: PreparedQQMessage;
	delivery?: QQOutboundDeliveryContext;
	ackTimer?: ReturnType<typeof setTimeout>;
	ackCancelled: boolean;
	cleaned: boolean;
}

interface ActiveConversationRun {
	key: string;
	qq: QQAgentSession;
	rootMessageId: string;
	abortController: AbortController;
	signal: AbortSignal;
	accepting: boolean;
	stopped: boolean;
	agentRunning: boolean;
	pendingPreparations: number;
	pendingCount: number;
	prepareTail: Promise<void>;
	ready: ActiveConversationInput[];
	submitted: Map<string, ActiveConversationInput>;
	submissionTasks: Set<Promise<void>>;
	inputs: Set<ActiveConversationInput>;
	deliveries: QQOutboundDeliveryContext[];
	current?: ActiveConversationInput;
	currentDelivery?: QQOutboundDeliveryContext;
	finalText: string;
	tools: QQToolCall[];
	hadAgentRun: boolean;
	wake?: () => void;
}

export class PiQQBotRuntime {
	private config: PiQQBotConfig;

	private auth?: QQAuth;
	private gateway?: QQGateway;
	private api?: QQApi;
	private readonly queue: MessageQueue;
	private readonly attachmentPipeline: AttachmentPipeline;
	private readonly seenMessages = new MessageDedupe(2 * 60 * 60 * 1000, 2000);
	private readonly accessRequests = new QQAccessRequestStore();
	private conversations?: ConversationRegistry;
	private runtimeAbort = new AbortController();
	private activeRunAbort?: AbortController;
	private agentCwd = process.cwd();

	private ctx?: ExtensionContext;
	private running = false;
	private startingConversationKey?: string;
	private activeConversation?: ActiveConversationRun;
	private activeTarget?: QQReplyTarget;
	private activeFake = false;

	private state: ConnectionState = "disconnected";
	private stateDetail?: string;
	private lastError?: string;
	private lastAttachmentError?: string;
	private activeAttachmentStatus?: string;
	private lastOutboundMediaError?: string;
	private activeOutboundMediaStatus?: string;
	private lastInbound?: InboundSummary;
	private lastOutbound?: OutboundSummary;

	private pumpScheduled = false;
	private pumpTimer?: ReturnType<typeof setTimeout>;
	private fakeCounter = 0;
	private observer?: QQConversationObserver;
	/** Next passive-reply msg_seq per inbound msg_id (acks and multi-chunk answers share one budget). */
	private readonly nextMsgSeq = new Map<string, number>();
	/** msg_ids that already received a slow-task progress ack. */
	private readonly progressAckSent = new Set<string>();

	constructor(config: PiQQBotConfig) {
		this.config = config;
		this.queue = new MessageQueue(config.maxQueueSize ?? 20);
		this.attachmentPipeline = new AttachmentPipeline(config, randomUUID());
	}

	applyRuntimeConfig(config: PiQQBotConfig): void {
		// Gateway credentials, storage, and media boundaries are cold settings and
		// cause Host replacement. These command/display settings are safe to apply
		// to an already connected runtime.
		this.config = {
			...this.config,
			allowUsers: [...(config.allowUsers ?? [])],
			allowGroups: [...(config.allowGroups ?? [])],
			replyPrefix: config.replyPrefix,
			sendBusyNotice: config.sendBusyNotice,
			showProcess: config.showProcess,
			replyFormat: config.replyFormat,
			progress: { ...config.progress },
			outboundMedia: { ...config.outboundMedia, allowedRoots: [...config.outboundMedia.allowedRoots] },
			debug: config.debug,
			commands: { ...config.commands, admins: [...config.commands.admins] },
		};
	}

	applyAccessConfig(config: PiQQBotConfig): void {
		this.applyRuntimeConfig(config);
	}

	attachObserver(observer: QQConversationObserver): void {
		this.observer = observer;
		this.emitRuntimeState();
	}

	detachObserver(observer?: QQConversationObserver): void {
		if (!observer || this.observer === observer) this.observer = undefined;
	}

	isReady(): boolean {
		return this.conversations !== undefined && this.state !== "disconnected";
	}

	isIdle(): boolean {
		return !this.running && this.waitingMessageCount() === 0;
	}

	async waitForIdle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (!this.isIdle() && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
		}
		return this.isIdle();
	}

	/**
	 * Bind or clear the local TUI context used only for optional notifications.
	 * The QQ gateway outlives local sessions, so this must be refreshed on
	 * attach and cleared on detach/shutdown to avoid stale ctx access.
	 */
	bindUiContext(ctx?: ExtensionContext): void {
		this.ctx = ctx;
	}

	async start(ctx: ExtensionContext): Promise<boolean> {
		this.bindUiContext(ctx);
		this.agentCwd = ctx.cwd;
		this.runtimeAbort = new AbortController();
		this.state = "connecting";
		this.emitRuntimeState();

		// Conversation runtimes are created lazily after allowlist admission. This
		// keeps startup fast while preserving strict isolation from the local TUI.
		const sdk = await import(pathToFileURL(resolveSdkEntry()).href);
		this.conversations = new ConversationRegistry(this.config, sdk.getAgentDir(), ctx.cwd);

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
		const active = this.activeConversation;
		if (active) {
			active.accepting = false;
			active.stopped = true;
			active.qq.clearPendingMessages();
			this.notifyActiveChange(active);
		}
		this.runtimeAbort.abort(new Error("QQBot stopped"));
		this.activeRunAbort?.abort(new Error("QQBot stopped"));
		this.activeRunAbort = undefined;
		if (this.pumpTimer) clearTimeout(this.pumpTimer);
		this.pumpTimer = undefined;
		this.pumpScheduled = false;
		this.gateway?.close();
		this.gateway = undefined;
		const conversations = this.conversations;
		this.conversations = undefined;
		await conversations?.dispose();
		this.queue.clear();
		this.startingConversationKey = undefined;
		this.activeConversation = undefined;
		this.activeTarget = undefined;
		this.activeFake = false;
		this.activeAttachmentStatus = undefined;
		this.activeOutboundMediaStatus = undefined;
		this.running = false;
		this.state = "disconnected";
		this.stateDetail = undefined;
		this.bindUiContext(undefined);
		this.emitRuntimeState();
	}

	async reconnect(): Promise<void> {
		if (!this.gateway) return;
		this.lastError = undefined;
		await this.gateway.reconnect();
	}

	listAccessRequests(): QQAccessRequest[] {
		return this.accessRequests.list();
	}

	approveAccessRequest(code: string): QQAccessRequest | undefined {
		return this.accessRequests.approve(code);
	}

	denyAccessRequest(code: string): QQAccessRequest | undefined {
		return this.accessRequests.deny(code);
	}

	async notifyAccessDecision(request: QQAccessRequest, decision: "user" | "admin" | "denied"): Promise<void> {
		const text = decision === "denied"
			? "## 访问申请未通过\n\n主机管理员没有批准本次申请。"
			: `## 访问申请已批准\n\n权限：**${decision === "admin" ? "管理员" : "普通用户"}**\n\n现在可以重新发送消息。`;
		await this.replyToQQ(request.message, text);
	}

	private emitAccessRequest(request: QQAccessRequest): void {
		this.notify(
			`QQBot 收到新的访问申请\n申请码：${request.code}\n用户：${maskOpenId(request.userOpenId)}\n使用 /qqbot-requests 处理`,
			"warning",
		);
	}

	private async replyToUnauthorizedApplicant(request: QQAccessRequest): Promise<void> {
		await this.replyToQQ(
			request.message,
			`## 已提交访问申请\n\n申请码：\`${request.code}\`\n\n请等待主机管理员确认。申请 10 分钟内有效；批准后请重新发送消息。`,
		).catch((err) => this.debugLog(`access request reply failed: ${err instanceof Error ? err.message : String(err)}`));
	}

	// --- Agent run (isolated QQ session) ------------------------------------

	private async runOne(msg: QQInboundMessage): Promise<void> {
		const key = conversationKey(msg);
		const runAbort = new AbortController();
		this.running = true;
		this.startingConversationKey = key;
		this.activeRunAbort = runAbort;
		this.activeTarget = replyTargetFor(msg);
		this.activeFake = msg.fake === true;
		this.emitRuntimeState();

		let qq: QQAgentSession;
		try {
			if (!this.conversations) throw new Error("conversation registry not ready");
			qq = await this.conversations.get(msg);
		} catch (err) {
			if (!runAbort.signal.aborted && !this.runtimeAbort.signal.aborted) {
				this.lastError = `qq session init failed: ${err instanceof Error ? err.message : String(err)}`;
				this.emit({ kind: "error", messageId: msg.id, stage: "session init", message: this.lastError, at: Date.now() });
				await this.replyToQQ(
					msg,
					`## QQ 会话不可用\n\n${formatUserFacingAgentError(err)}\n\n请稍后重试，或在主机查看 /qqbot-status。`,
				).catch(() => undefined);
			}
			this.finishStartingRun(key, runAbort);
			return;
		}
		if (runAbort.signal.aborted || this.runtimeAbort.signal.aborted) {
			this.finishStartingRun(key, runAbort);
			return;
		}

		this.startingConversationKey = undefined;
		const active: ActiveConversationRun = {
			key,
			qq,
			rootMessageId: msg.id,
			abortController: runAbort,
			signal: AbortSignal.any([this.runtimeAbort.signal, runAbort.signal]),
			accepting: true,
			stopped: false,
			agentRunning: false,
			pendingPreparations: 0,
			pendingCount: 0,
			prepareTail: Promise.resolve(),
			ready: [],
			submitted: new Map(),
			submissionTasks: new Set(),
			inputs: new Set(),
			deliveries: [],
			finalText: "",
			tools: [],
			hadAgentRun: false,
		};
		this.activeConversation = active;
		this.emit({ kind: "run_start", messageId: msg.id, at: Date.now() });

		this.admitActiveMessage(active, msg, false);
		const alreadyQueued = this.queue.takeWhere((queued) => conversationKey(queued) === active.key);
		for (const queued of alreadyQueued) this.admitActiveMessage(active, queued, true);
		this.emitRuntimeState();

		try {
			await this.runActiveConversation(active);
			if (active.signal.aborted || !active.hadAgentRun || !active.current) return;
			const finalInput = active.current;

			for (const input of active.inputs) this.cancelInputProgressAck(input);
			const records = active.deliveries.flatMap((delivery) => [...delivery.records]);
			const deliverySummary = formatDeliverySummary(records);
			const answer = [deliverySummary, active.finalText.trim()].filter(Boolean).join("\n\n");
			const body = this.config.showProcess
				? formatWithProcess(buildTranscript(active.tools), answer)
				: answer;
			const sentMedia = records.some((record) => record.status === "sent");
			if (body.trim()) {
				await this.deliverReply(finalInput.target, body, finalInput.msg.fake === true, undefined, sentMedia);
			} else if (!sentMedia) {
				this.debugLog("assistant produced no text or media; sending empty-result fallback");
				await this.deliverReply(
					finalInput.target,
					"本次没有生成可发送的文本或文件结果。可以换个问法，或发送 /status 查看状态。",
					finalInput.msg.fake === true,
				);
			}
		} catch (err) {
			for (const input of active.inputs) this.cancelInputProgressAck(input);
			if (!active.signal.aborted) {
				const failedInput = active.current ?? [...active.inputs].at(-1);
				this.lastError = `qq session run failed: ${err instanceof Error ? err.message : String(err)}`;
				this.emit({ kind: "error", messageId: failedInput?.msg.id ?? msg.id, stage: "agent run", message: this.lastError, at: Date.now() });
				this.debugLog(this.lastError);
				if (failedInput) {
					await this.deliverReply(
						failedInput.target,
						`## 处理失败\n\n${formatUserFacingAgentError(err)}`,
						failedInput.msg.fake === true,
						this.commandKeyboard(failedInput.msg, [[{ label: "当前状态", command: "/status", primary: true }, { label: "停止任务", command: "/stop" }]]),
					).catch((sendErr) => {
						this.debugLog(`failed to deliver error reply: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
					});
				}
			}
		} finally {
			active.accepting = false;
			active.stopped = true;
			active.qq.clearPendingMessages();
			if (!runAbort.signal.aborted) runAbort.abort(new Error("QQ aggregate run finished"));
			this.notifyActiveChange(active);
			await active.prepareTail.catch(() => undefined);
			await Promise.allSettled([...active.submissionTasks]);
			for (const delivery of active.deliveries) delivery.close();
			qq.bindOutboundDelivery(undefined);
			await Promise.allSettled([...active.inputs].map((input) => this.cleanupActiveInput(input)));
			for (const input of active.inputs) {
				this.cancelInputProgressAck(input);
				this.nextMsgSeq.delete(input.msg.id);
				this.progressAckSent.delete(input.msg.id);
			}
			if (this.activeConversation === active) {
				this.activeConversation = undefined;
				this.running = false;
				this.activeTarget = undefined;
				this.activeFake = false;
				this.activeAttachmentStatus = undefined;
				this.activeOutboundMediaStatus = undefined;
			}
			if (this.activeRunAbort === runAbort) this.activeRunAbort = undefined;
			this.emit({ kind: "run_end", messageId: msg.id, at: Date.now() });
			this.emitRuntimeState();
			this.schedulePump();
		}
	}

	private finishStartingRun(key: string, runAbort: AbortController): void {
		if (this.startingConversationKey === key) {
			this.startingConversationKey = undefined;
			this.running = false;
			this.activeTarget = undefined;
			this.activeFake = false;
		}
		if (this.activeRunAbort === runAbort) this.activeRunAbort = undefined;
		this.emitRuntimeState();
		this.schedulePump();
	}

	private admitActiveMessage(active: ActiveConversationRun, msg: QQInboundMessage, pendingSlot: boolean): ActiveConversationInput {
		const input: ActiveConversationInput = {
			msg,
			target: replyTargetFor(msg),
			pendingSlot,
			pendingReleased: !pendingSlot,
			ackCancelled: false,
			cleaned: false,
		};
		active.inputs.add(input);
		if (pendingSlot) active.pendingCount++;
		this.startInputProgressAck(active, input);
		active.pendingPreparations++;
		const preparation = active.prepareTail
			.then(() => this.prepareActiveInput(active, input))
			.catch((err) => this.handleActiveInputPreparationError(active, input, err))
			.finally(() => {
				active.pendingPreparations = Math.max(0, active.pendingPreparations - 1);
				this.activeAttachmentStatus = undefined;
				this.notifyActiveChange(active);
			});
		active.prepareTail = preparation;
		this.notifyActiveChange(active);
		return input;
	}

	private async prepareActiveInput(active: ActiveConversationRun, input: ActiveConversationInput): Promise<void> {
		if (active.stopped || active.signal.aborted) throw active.signal.reason ?? new Error("QQ task stopped");
		const msg = input.msg;
		const prepared = await this.attachmentPipeline.prepare(msg, active.signal, {
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
		input.prepared = prepared;
		this.activeAttachmentStatus = undefined;
		if (active.stopped || active.signal.aborted) {
			this.releasePendingSlot(active, input);
			await this.cleanupActiveInput(input);
			return;
		}

		const readyImages = prepared.resources.filter((resource) => resource.kind === "image" && resource.status === "ready");
		if (readyImages.length && !active.qq.supportsImages()) {
			const reply = msg.text.trim()
				? "当前 QQ Agent 使用的模型不支持图片理解。我没有读取图片；请切换到支持视觉输入的模型后重试。你的文字内容也未提交，以避免产生误导性回答。"
				: "当前 QQ Agent 使用的模型不支持图片理解，因此没有运行可能产生误导的模型回合。请切换到支持视觉输入的模型后重试。";
			await this.rejectPreparedInput(active, input, reply);
			return;
		}
		if (!hasUsableAgentInput(msg, prepared.resources)) {
			await this.rejectPreparedInput(active, input, formatAttachmentFailures(prepared.resources));
			return;
		}

		active.ready.push(input);
		this.flushReadyAsSteers(active);
		this.notifyActiveChange(active);
	}

	private async handleActiveInputPreparationError(
		active: ActiveConversationRun,
		input: ActiveConversationInput,
		err: unknown,
	): Promise<void> {
		this.cancelInputProgressAck(input);
		this.releasePendingSlot(active, input);
		if (!active.signal.aborted && !active.stopped) {
			this.lastError = `attachment preparation failed: ${err instanceof Error ? err.message : String(err)}`;
			this.emit({ kind: "error", messageId: input.msg.id, stage: "attachment preparation", message: this.lastError, at: Date.now() });
			this.debugLog(this.lastError);
			await this.deliverReply(
				input.target,
				`## 处理失败\n\n${formatUserFacingAgentError(err)}`,
				input.msg.fake === true,
			).catch((sendErr) => {
				this.debugLog(`failed to deliver attachment error: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
			});
		}
		await this.cleanupActiveInput(input);
	}

	private async rejectPreparedInput(active: ActiveConversationRun, input: ActiveConversationInput, reply: string): Promise<void> {
		this.cancelInputProgressAck(input);
		this.releasePendingSlot(active, input);
		if (!active.signal.aborted && !active.stopped) {
			await this.deliverReply(input.target, reply, input.msg.fake === true).catch((err) => {
				this.debugLog(`failed to deliver rejected input: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
		await this.cleanupActiveInput(input);
	}

	private async runActiveConversation(active: ActiveConversationRun): Promise<void> {
		while (!active.signal.aborted && !active.stopped) {
			const input = active.ready.shift();
			if (!input) {
				if (active.pendingPreparations === 0 && active.submitted.size === 0 && active.submissionTasks.size === 0) {
					active.accepting = false;
					this.notifyActiveChange(active);
					return;
				}
				await this.waitForActiveChange(active);
				continue;
			}

			this.activateInput(active, input);
			active.agentRunning = true;
			active.hadAgentRun = true;
			try {
				const result = await active.qq.run(
					withQQReplyGuidance(input.prepared?.prompt ?? ""),
					input.prepared?.images ?? [],
					(event) => this.forwardAgentEvent(active, event),
				);
				active.finalText = result.text;
				active.tools.push(...result.tools);
			} finally {
				active.agentRunning = false;
				if (active.submissionTasks.size) await Promise.allSettled([...active.submissionTasks]);
				if (!active.signal.aborted && !active.stopped) {
					// A steer can land after Pi's final queue poll but before isStreaming
					// flips false. Such an input has no user_message event yet. Remove the
					// orphaned native queue entry and run it as the next aggregate base.
					if (active.submitted.size > 0 && active.qq.pendingMessageCount() > 0) {
						active.qq.clearPendingMessages();
						this.requeueSubmittedInputs(active);
					} else {
						this.reconcileSubmittedInputs(active);
					}
				} else {
					active.submitted.clear();
				}
				this.notifyActiveChange(active);
			}
		}
	}

	private flushReadyAsSteers(active: ActiveConversationRun): void {
		if (!active.agentRunning || !active.qq.isStreaming() || active.stopped || active.signal.aborted) return;
		const ready = active.ready.splice(0);
		for (const input of ready) this.submitSteeringInput(active, input);
	}

	private submitSteeringInput(active: ActiveConversationRun, input: ActiveConversationInput): void {
		const prepared = input.prepared;
		if (!prepared) return;
		active.submitted.set(prepared.correlationId, input);
		let task: Promise<void>;
		task = active.qq.steer(withQQReplyGuidance(prepared.prompt), prepared.images)
			.then(() => {
				this.emit({ kind: "steered", messageId: input.msg.id, pending: this.waitingMessageCount(), at: Date.now() });
			})
			.catch(async (err) => {
				if (!active.submitted.delete(prepared.correlationId)) return;
				if (active.signal.aborted || active.stopped) {
					this.releasePendingSlot(active, input);
					await this.cleanupActiveInput(input);
					return;
				}
				this.lastError = `steering submission failed: ${err instanceof Error ? err.message : String(err)}`;
				this.emit({ kind: "error", messageId: input.msg.id, stage: "steering", message: this.lastError, at: Date.now() });
				await this.rejectPreparedInput(
					active,
					input,
					`## 插嘴消息未提交\n\n${formatUserFacingAgentError(err)}`,
				);
			})
			.finally(() => {
				active.submissionTasks.delete(task);
				this.notifyActiveChange(active);
			});
		active.submissionTasks.add(task);
	}

	private requeueSubmittedInputs(active: ActiveConversationRun): void {
		const late = [...active.submitted.values()];
		active.submitted.clear();
		active.ready.unshift(...late);
	}

	private reconcileSubmittedInputs(active: ActiveConversationRun): void {
		for (const [correlationId, input] of active.submitted) {
			active.submitted.delete(correlationId);
			this.activateInput(active, input);
		}
	}

	private activateInput(active: ActiveConversationRun, input: ActiveConversationInput): void {
		if (active.current === input) {
			this.releasePendingSlot(active, input);
			return;
		}
		active.currentDelivery?.close();
		active.current = input;
		this.activeTarget = input.target;
		this.activeFake = input.msg.fake === true;
		const delivery = new QQOutboundDeliveryContext({
			config: this.config,
			cwd: this.agentCwd,
			message: input.msg,
			target: input.target,
			api: this.api,
			signal: active.signal,
			fake: input.msg.fake === true,
			hasMessageSequenceCapacity: () => this.hasMediaReplyCapacity(input.msg.id),
			reserveMessageSequence: () => this.reserveMediaReplySequence(input.msg.id),
			onEvent: ({ stage, record }) => {
				if (stage === "start") this.cancelInputProgressAck(input);
				this.activeOutboundMediaStatus = stage === "sent" || stage === "failed"
					? undefined
					: `${stage}: ${record.filename}`;
				if (stage === "failed") this.lastOutboundMediaError = `${record.errorCode ?? "outbound_failed"}: ${record.filename}`;
				this.emit({
					kind: stage === "start" ? "outbound_start" : stage === "uploaded" ? "outbound_uploaded" : stage === "sent" ? "outbound_sent" : "outbound_failed",
					messageId: input.msg.id,
					mediaKind: record.kind,
					filename: record.filename,
					bytes: record.bytes,
					...(record.errorCode ? { errorCode: record.errorCode } : {}),
					...(record.note ? { note: record.note } : {}),
					at: Date.now(),
				});
			},
		});
		input.delivery = delivery;
		active.currentDelivery = delivery;
		active.deliveries.push(delivery);
		active.qq.bindOutboundDelivery(delivery);
		this.releasePendingSlot(active, input);
		this.emitRuntimeState();
	}

	private releasePendingSlot(active: ActiveConversationRun, input: ActiveConversationInput): void {
		if (input.pendingReleased) return;
		input.pendingReleased = true;
		active.pendingCount = Math.max(0, active.pendingCount - 1);
		this.notifyActiveChange(active);
	}

	private startInputProgressAck(active: ActiveConversationRun, input: ActiveConversationInput): void {
		if (!this.config.progress.enabled || input.msg.fake) return;
		const sendAck = () => {
			if (!input.ackCancelled && !active.stopped && this.activeConversation === active && this.running) {
				void this.sendProgressAck(input.msg);
			}
		};
		if (this.config.progress.ackAfterMs <= 0) sendAck();
		else input.ackTimer = setTimeout(sendAck, this.config.progress.ackAfterMs);
	}

	private cancelInputProgressAck(input: ActiveConversationInput): void {
		input.ackCancelled = true;
		if (input.ackTimer) clearTimeout(input.ackTimer);
		input.ackTimer = undefined;
	}

	private async cleanupActiveInput(input: ActiveConversationInput): Promise<void> {
		if (input.cleaned) return;
		input.cleaned = true;
		await input.prepared?.cleanup().catch(() => undefined);
	}

	private waitForActiveChange(active: ActiveConversationRun): Promise<void> {
		return new Promise<void>((resolve) => {
			active.wake = resolve;
		});
	}

	private notifyActiveChange(active: ActiveConversationRun): void {
		const wake = active.wake;
		active.wake = undefined;
		wake?.();
		if (this.activeConversation === active) this.emitRuntimeState();
	}

	private forwardAgentEvent(active: ActiveConversationRun, event: QQAgentRunEvent): void {
		if (event.kind === "agent_start") {
			this.flushReadyAsSteers(active);
			return;
		}
		if (event.kind === "user_message") {
			const correlationId = extractQQCorrelationId(event.text);
			const input = correlationId ? active.submitted.get(correlationId) : undefined;
			if (input && correlationId) {
				active.submitted.delete(correlationId);
				this.activateInput(active, input);
				this.notifyActiveChange(active);
			}
			return;
		}

		const messageId = active.current?.msg.id ?? active.rootMessageId;
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
			// Before approval retain identity/event metadata only. Unauthorized
			// message text and attachment names must not remain in diagnostics.
			text: allowed ? msg.text : "",
			attachments: allowed ? attachmentSummary : [],
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
			if (this.config.commands.accessRequests && msg.type === "private") {
				const admission = this.accessRequests.admit(msg);
				if (admission.request && admission.created) {
					this.emitAccessRequest(admission.request);
					void this.replyToUnauthorizedApplicant(admission.request);
				}
			}
			return;
		}

		if (!this.seenMessages.admit(msg.id, msg.receivedAt)) {
			this.debugLog(`ignored duplicate msg_id=${sanitizeLogValue(msg.id)}`);
			return;
		}

		const text = normalizeCommandText(msg.text);
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
		if (text.startsWith("/")) {
			if (msg.attachments.length > 0) {
				void this.replyToQQ(msg, "## 命令未执行\n\n管理命令不能与附件同时发送。请单独发送命令，附件没有被下载。");
				return;
			}
			this.handleCommand(msg, text);
			return;
		}
		this.enqueuePrompt(msg);
	}

	private enqueuePrompt(msg: QQInboundMessage): void {
		const active = this.activeConversation;
		const canSteer = active?.accepting === true && !active.stopped && active.key === conversationKey(msg);
		if (this.waitingMessageCount() >= (this.config.maxQueueSize ?? 20)) {
			this.rejectPromptForCapacity(msg);
			return;
		}
		if (canSteer && active) {
			this.admitActiveMessage(active, msg, true);
			this.emit({ kind: "queued", messageId: msg.id, queueSize: this.waitingMessageCount(), at: Date.now() });
			this.emitRuntimeState();
			return;
		}

		if (!this.queue.enqueue(msg)) {
			this.rejectPromptForCapacity(msg);
			return;
		}
		this.emit({ kind: "queued", messageId: msg.id, queueSize: this.waitingMessageCount(), at: Date.now() });
		this.emitRuntimeState();
		this.schedulePump();
	}

	private rejectPromptForCapacity(msg: QQInboundMessage): void {
		this.lastError = "queue full; message dropped";
		this.emit({ kind: "error", messageId: msg.id, stage: "queue", message: this.lastError, at: Date.now() });
		this.emitRuntimeState();
		this.debugLog(this.lastError);
		if (this.config.sendBusyNotice && !msg.fake) void this.sendBusyNotice(msg);
	}

	// --- QQ command control plane -----------------------------------------

	private handleCommand(msg: QQInboundMessage, text: string): void {
		let command: ParsedQQCommand | undefined;
		try {
			command = parseQQCommand(text);
		} catch (err) {
			void this.replyToQQ(msg, `## 命令未执行\n\n${err instanceof Error ? err.message : String(err)}\n\n发送 \`/help\` 查看用法。`);
			return;
		}
		if (!command) return;
		const authorization = authorizeQQCommand(this.config, msg, command);
		if (!authorization.allowed) {
			const known = QQ_COMMAND_NAMES.has(command.name);
			const blocked = QQ_REMOTE_BLOCKED_COMMANDS.has(command.name);
			const title = known && !blocked ? "命令未开启或无权限" : "命令未执行";
			void this.replyToQQ(msg, `## ${title}\n\n${authorization.reason}\n\n发送 \`/help\` 查看可用命令。`);
			return;
		}
		void this.executeCommand(msg, command).catch((err) => {
			const detail = err instanceof Error ? err.message : String(err);
			this.lastError = `command /${command?.name ?? "unknown"} failed: ${detail}`;
			this.emit({ kind: "error", messageId: msg.id, stage: "command", message: this.lastError, at: Date.now() });
			return this.replyToQQ(
				msg,
				`## 命令未执行\n\n${sanitizeCommandError(detail)}\n\n当前 QQ 会话仍保持原状态。发送 \`/help ${command?.name ?? ""}\` 查看用法。`,
			);
		});
	}

	private async executeCommand(msg: QQInboundMessage, command: ParsedQQCommand): Promise<void> {
		switch (command.name) {
			case "help":
				await this.replyToQQ(msg, this.commandHelp(command.args[0]), this.helpKeyboard(msg));
				return;
			case "status":
				await this.replyToQQ(msg, await this.qqStatusText(msg), this.helpKeyboard(msg));
				return;
			case "last":
				await this.replyToQQ(msg, this.lastSummary());
				return;
			case "model":
				await this.handleModelCommand(msg, command.rawArgs);
				return;
			case "thinking":
				await this.handleThinkingCommand(msg, command.args[0]);
				return;
			case "new":
				await this.handleNewCommand(msg, command.rawArgs);
				return;
			case "sessions":
				await this.handleSessionsCommand(msg, command.rawArgs);
				return;
			case "resume":
				await this.handleResumeCommand(msg, command.args[0]);
				return;
			case "name":
				await this.handleNameCommand(msg, command.rawArgs);
				return;
			case "compact":
				await this.handleCompactCommand(msg, command.rawArgs);
				return;
			case "stop":
				await this.handleStopCommand(msg);
				return;
		}
	}

	private async getConversation(msg: QQInboundMessage): Promise<QQAgentSession> {
		if (!this.conversations) throw new Error("QQ 会话运行时尚未就绪");
		return this.conversations.get(msg);
	}

	private async handleModelCommand(msg: QQInboundMessage, query: string): Promise<void> {
		const qq = await this.getConversation(msg);
		const current = qq.currentModel();
		const allModels = rankModels(await qq.availableModels(), "");
		const tokens = query.trim().split(/\s+/).filter(Boolean);
		let page = 1;
		if (tokens.length >= 2 && /^page$/i.test(tokens.at(-2) ?? "") && /^\d+$/.test(tokens.at(-1) ?? "")) {
			page = Math.max(1, Number(tokens.at(-1)));
			tokens.splice(-2, 2);
		}
		const queryText = tokens.join(" ").trim();
		let normalizedQuery = queryText.toLowerCase();
		if (!normalizedQuery) {
			const modelPage = buildModelPage(allModels, page, this.config.commands.modelPageSize);
			const lines = [
				"## 当前 QQ 模型",
				"",
				current ? `**${current.provider}/${current.id}**` : "当前没有可用模型",
				current ? `- 输入：${current.input.join("、")}` : "",
				`- 思考等级：${qq.thinkingLevel()}`,
				"",
				`## 可用模型（${modelPage.page}/${modelPage.totalPages}，共 ${modelPage.total} 个）`,
				"",
				...modelPage.models.map((model, index) => `${modelPage.offset + index + 1}. \`${model.provider}/${model.id}\`${model.input.includes("image") ? " · 图片" : ""}${model.reasoning ? " · 推理" : ""}`),
				"",
				formatModelPageFallback(modelPage),
			].filter(Boolean);
			await this.replyToQQ(msg, lines.join("\n"), this.modelKeyboard(msg, modelPage));
			return;
		}
		if (/^\d+$/.test(normalizedQuery)) {
			const index = Number(normalizedQuery) - 1;
			if (!allModels[index]) throw new Error("模型序号无效或列表已变化；请重新发送 /model");
			normalizedQuery = `${allModels[index].provider}/${allModels[index].id}`.toLowerCase();
		}
		const models = rankModels(allModels, normalizedQuery);
		const exact = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedQuery);
		const matches = exact ? [exact] : models.filter((model) => modelMatches(model, normalizedQuery));
		if (!matches.length) throw new Error(`没有找到已配置认证且匹配“${query.trim()}”的模型`);
		if (matches.length > 1) {
			const matchPage = buildModelPage(matches, page, this.config.commands.modelPageSize);
			const searchPageCommands = matchPage.fallbackCommands.map((command) =>
				command.replace("/model page", `/model ${queryText} page`),
			);
			await this.replyToQQ(
				msg,
				[
					"## 未切换模型",
					"",
					`找到 ${matchPage.total} 个匹配项（${matchPage.page}/${matchPage.totalPages}），请发送完整模型：`,
					"",
					...matchPage.models.map((model, index) => `${matchPage.offset + index + 1}. \`${model.provider}/${model.id}\``),
					"",
					searchPageCommands.length
						? `发送 \`${searchPageCommands.join("\` 或 \`")}\` 翻页。`
						: "请缩小搜索词，或发送完整的 `provider/model` 切换。",
				].join("\n"),
				this.searchModelKeyboard(msg, matchPage, queryText),
			);
			return;
		}
		const selected = await qq.setModel(matches[0].provider, matches[0].id);
		await this.replyToQQ(
			msg,
			`## 已切换 QQ 会话模型\n\n- 模型：\`${selected.provider}/${selected.id}\`\n- 输入：${selected.input.join("、")}\n- 思考等级：${qq.thinkingLevel()}\n\n继续发送问题即可。`,
			this.helpKeyboard(msg),
		);
	}

	private async handleThinkingCommand(msg: QQInboundMessage, requested?: string): Promise<void> {
		const qq = await this.getConversation(msg);
		const levels = qq.availableThinkingLevels();
		if (!requested) {
			await this.replyToQQ(
				msg,
				`## QQ 会话思考等级\n\n当前：**${qq.thinkingLevel()}**\n\n可选：${levels.map((level) => `\`${level}\``).join("、")}\n\n示例：\`/thinking high\``,
				this.thinkingKeyboard(msg, levels),
			);
			return;
		}

		const normalized = normalizeThinkingLevel(requested);
		const selected = levels.find((level) => level === normalized);
		if (!selected) {
			const suggestion = suggestThinkingLevel(normalized, levels);
			throw new Error([
				`思考等级“${requested}”无效`,
				`当前模型可选：${levels.join("、")}`,
				suggestion ? `你可能想输入：/thinking ${suggestion}` : "",
			].filter(Boolean).join("；"));
		}
		const effective = qq.setThinkingLevel(selected);
		await this.replyToQQ(msg, `## 已更新 QQ 会话\n\n思考等级：**${effective}**`);
	}

	private async handleNewCommand(msg: QQInboundMessage, name: string): Promise<void> {
		const qq = await this.getConversation(msg);
		if (qq.isStreaming() || this.hasActiveOrQueuedConversation(msg)) {
			throw new Error("当前 QQ 任务仍在执行或等待；请先发送 /stop，再发送 /new");
		}
		const created = await qq.newSession(name);
		const model = qq.currentModel();
		await this.replyToQQ(
			msg,
			`## 已新建 QQ 会话\n\n- 会话：${created.name ? `**${created.name}**` : "未命名"}\n- ID：\`${shortId(created.id)}\`\n- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\`\n\n直接发送新任务即可；旧会话仍保存在历史中。`,
			this.helpKeyboard(msg),
		);
	}

	private async handleSessionsCommand(msg: QQInboundMessage, query: string): Promise<void> {
		const qq = await this.getConversation(msg);
		const all = await qq.listSessions();
		const normalized = query.trim().toLowerCase();
		const sessions = (normalized && !/^\d+$/.test(normalized)
			? all.filter((session) => sessionMatches(session, normalized))
			: all
		).slice(0, this.config.commands.maxListItems);
		if (!sessions.length) {
			await this.replyToQQ(msg, "## QQ 会话\n\n没有找到可恢复的历史会话。发送 `/new` 创建一个新会话。");
			return;
		}
		const currentId = qq.sessionId();
		const lines = [
			"## QQ 会话",
			"",
			...sessions.map((session, index) => formatSessionLine(session, index, currentId)),
			"",
			"发送 `/resume 短ID` 恢复。",
		];
		await this.replyToQQ(msg, lines.join("\n"), this.sessionsKeyboard(msg, sessions));
	}

	private async handleResumeCommand(msg: QQInboundMessage, selector?: string): Promise<void> {
		if (!selector) {
			await this.handleSessionsCommand(msg, "");
			return;
		}
		const qq = await this.getConversation(msg);
		if (qq.isStreaming() || this.hasActiveOrQueuedConversation(msg)) {
			throw new Error("当前 QQ 任务仍在执行或等待；请先发送 /stop，再恢复会话");
		}
		const sessions = await qq.listSessions();
		const normalized = selector.toLowerCase();
		const matches = /^\d+$/.test(normalized)
			? sessions.slice(0, this.config.commands.maxListItems).filter((_session, index) => index === Number(normalized) - 1)
			: sessions.filter((session) => {
				const compactId = session.id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
				return compactId.startsWith(normalized) || compactId.endsWith(normalized) || session.name?.toLowerCase() === normalized;
			});
		if (!matches.length) throw new Error(`没有找到短 ID 或名称为“${selector}”的 QQ 会话；请重新发送 /sessions`);
		if (matches.length > 1) throw new Error(`“${selector}”匹配多个 QQ 会话；请使用更完整的短 ID`);
		if (matches[0].id === qq.sessionId()) {
			await this.replyToQQ(msg, `当前已经是 QQ 会话 \`${shortId(matches[0].id)}\`，无需切换。`);
			return;
		}
		const resumed = await qq.resumeSession(matches[0].path);
		const model = qq.currentModel();
		await this.replyToQQ(
			msg,
			`## 已恢复 QQ 会话\n\n- 会话：${resumed.name ? `**${resumed.name}**` : "未命名"}\n- ID：\`${shortId(resumed.id)}\`\n- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\`\n\n后续消息会继续进入该 QQ 会话。`,
		);
	}

	private async handleNameCommand(msg: QQInboundMessage, name: string): Promise<void> {
		if (!name.trim()) throw new Error("会话名称不能为空；示例：/name 修复登录问题");
		const qq = await this.getConversation(msg);
		const saved = qq.setSessionName(name);
		await this.replyToQQ(msg, `已将当前 QQ 会话命名为：**${escapeMarkdownInline(saved)}**`);
	}

	private async handleCompactCommand(msg: QQInboundMessage, instructions: string): Promise<void> {
		const qq = await this.getConversation(msg);
		const result = await qq.compact(instructions);
		await this.replyToQQ(
			msg,
			`## QQ 会话压缩完成\n\n${result.tokensBefore ? `压缩前上下文约 ${result.tokensBefore} tokens。` : "较早内容已汇总，完整历史仍保存在会话文件中。"}`,
		);
	}

	private hasActiveOrQueuedConversation(msg: QQInboundMessage): boolean {
		const key = conversationKey(msg);
		return (this.running && (this.startingConversationKey === key || this.activeConversation?.key === key)) ||
			this.queue.hasWhere((queued) => conversationKey(queued) === key);
	}

	private async handleStopCommand(msg: QQInboundMessage): Promise<void> {
		const key = conversationKey(msg);
		const active = this.activeConversation?.key === key ? this.activeConversation : undefined;
		const starting = this.running && this.startingConversationKey === key;
		const qq = active?.qq ?? this.conversations?.peek(msg);
		const removedFromQueue = this.queue.removeWhere((queued) => conversationKey(queued) === key);
		const removedFromActive = active?.pendingCount ?? 0;
		const wasRunning = !!active || starting || qq?.isStreaming() === true;
		if (active) {
			active.accepting = false;
			active.stopped = true;
			active.qq.clearPendingMessages();
			active.abortController.abort(new Error("QQ task stopped"));
			this.notifyActiveChange(active);
		} else if (wasRunning) {
			qq?.clearPendingMessages();
			this.activeRunAbort?.abort(new Error("QQ task stopped"));
		}
		if (wasRunning) await qq?.abort();
		const removed = removedFromQueue + removedFromActive;
		this.emitRuntimeState();
		await this.replyToQQ(
			msg,
			wasRunning || removed
				? `## 已停止 QQ 任务\n\n${wasRunning ? "当前生成已中止。" : ""}${removed ? ` 已移除 ${removed} 条待处理或待插嘴消息。` : ""}\n\nQQ 会话历史已保留。`
				: "当前 QQ 会话没有正在执行或等待的任务。",
		);
	}

	private commandHelp(command?: string): string {
		const detail = command?.toLowerCase();
		const usages: Record<string, string> = {
			model: "`/model` 查看当前和可用模型；`/model provider/model` 切换 QQ 会话模型。",
			thinking: "`/thinking` 查看当前模型支持的等级；例如 `/thinking high` 或 `/thinking xhigh` 修改 QQ 会话思考等级。等级名称需按列表准确输入。",
			new: "`/new [名称]` 新建 QQ 会话。旧会话会保留；运行中请先 `/stop`。",
			sessions: "`/sessions [关键词]` 查看或搜索当前 QQ 对话的历史会话。",
			resume: "`/resume <短ID|唯一名称>` 恢复 QQ 会话。先用 `/sessions` 获取短 ID。",
			name: "`/name <名称>` 命名当前 QQ 会话。",
			compact: "`/compact [附加要求]` 压缩当前 QQ 会话上下文。",
			stop: "`/stop` 中止当前 QQ 任务并移除该对话尚未处理的消息。",
		};
		if (detail && usages[detail]) return `## /${detail}\n\n${usages[detail]}`;
		return [
			"## QQ Agent 命令",
			"",
			"- `/status` 当前模型、QQ 会话和运行状态",
			"- `/model [查询]` 查看或切换模型",
			"- `/thinking [等级]` 查看或修改思考等级",
			"- `/new [名称]` 新建 QQ 会话",
			"- `/sessions [关键词]` 查看历史 QQ 会话",
			"- `/resume <短ID>` 恢复 QQ 会话",
			"- `/name <名称>` 命名当前 QQ 会话",
			"- `/compact [要求]` 压缩上下文",
			"- `/stop` 停止当前任务",
			"",
			"这些命令只管理隔离的 **QQ 会话**，不会切换电脑终端里的本地 Pi 会话。",
		].join("\n");
	}

	private async qqStatusText(msg: QQInboundMessage): Promise<string> {
		const qq = await this.getConversation(msg);
		const model = qq.currentModel();
		return [
			"## QQ Agent 状态",
			"",
			`- 连接：${this.state === "connected" ? "已连接" : this.state}`,
			`- 会话：${qq.sessionName() ? `**${escapeMarkdownInline(qq.sessionName() ?? "")}**` : "未命名"} (\`${shortId(qq.sessionId())}\`)`,
			`- 模型：\`${model ? `${model.provider}/${model.id}` : "unknown"}\``,
			`- 思考：\`${qq.thinkingLevel()}\``,
			`- 当前任务：${qq.isStreaming() || (this.running && (this.startingConversationKey === conversationKey(msg) || this.activeConversation?.key === conversationKey(msg))) ? "执行中" : "空闲"}`,
			`- 等待消息：${this.waitingMessageCount()}`,
			`- 历史模式：${this.config.sessions.mode === "persistent" ? "持久化" : "内存"}`,
			`- 宿主：${this.config.startup.keepAcrossLocalSessions ? "本地会话切换保持" : "会话级"}`,
		].join("\n");
	}

	private helpKeyboard(msg: QQInboundMessage): QQKeyboard | undefined {
		return this.commandKeyboard(msg, [
			[{ label: "当前状态", command: "/status", primary: true }, { label: "切换模型", command: "/model" }],
			[{ label: "新建会话", command: "/new" }, { label: "历史会话", command: "/sessions" }],
			[{ label: "停止任务", command: "/stop" }, { label: "帮助", command: "/help" }],
		]);
	}

	private modelKeyboard(msg: QQInboundMessage, page: ModelPage): QQKeyboard | undefined {
		return this.commandKeyboard(msg, page.keyboardRows);
	}

	private searchModelKeyboard(msg: QQInboundMessage, page: ModelPage, query: string): QQKeyboard | undefined {
		const rows = page.keyboardRows.map((row) => row.map((button) => ({ ...button })));
		const navigation = rows.at(-2);
		if (page.totalPages > 1 && navigation) {
			for (const button of navigation) {
				button.command = button.command.replace("/model page", `/model ${query} page`);
			}
		}
		return this.commandKeyboard(msg, rows);
	}

	private thinkingKeyboard(msg: QQInboundMessage, levels: string[]): QQKeyboard | undefined {
		const rows: QQCommandButton[][] = [];
		for (let index = 0; index < levels.length; index += 2) {
			rows.push(levels.slice(index, index + 2).map((level) => ({ label: level, command: `/thinking ${level}` })));
		}
		return this.commandKeyboard(msg, rows);
	}

	private sessionsKeyboard(msg: QQInboundMessage, sessions: QQSessionInfo[]): QQKeyboard | undefined {
		const rows: QQCommandButton[][] = [];
		for (let index = 0; index < sessions.length; index += 2) {
			rows.push(sessions.slice(index, index + 2).map((session) => ({
				label: sessionButtonLabel(session),
				command: `/resume ${shortId(session.id)}`,
			})));
		}
		rows.push([{ label: "新建会话", command: "/new", primary: true }, { label: "返回帮助", command: "/help" }]);
		return this.commandKeyboard(msg, rows);
	}

	private commandKeyboard(msg: QQInboundMessage, rows: QQCommandButton[][]): QQKeyboard | undefined {
		return this.config.commands.buttons ? buildCommandKeyboard(msg, rows) : undefined;
	}

	private async replyToQQ(msg: QQInboundMessage, text: string, keyboard?: QQKeyboard): Promise<void> {
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		await this.deliverReply(target, text, msg.fake === true, keyboard);
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
		if (!this.conversations) return;
		const msg = this.queue.dequeue();
		if (!msg) return;
		this.emitRuntimeState();
		void this.runOne(msg);
	}

	// --- Outbound ------------------------------------------------------------

	private async deliverReply(
		target: QQReplyTarget,
		text: string,
		fake: boolean,
		keyboard?: QQKeyboard,
		forcePlain = false,
	): Promise<void> {
		const full = (this.config.replyPrefix ?? "") + text;
		const replyFormat = forcePlain ? "plain" : this.config.replyFormat;
		const formatted = formatQQReply(full, replyFormat);
		const chunks = replyFormat === "plain" ? formatted.plain : formatted.markdown;

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
			this.debugLog(`[fake] would send ${chunks.length} ${replyFormat === "plain" ? "plain" : "markdown"} chunk(s) to ${target.type}`);
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
		let nextMsgSeq = this.nextMsgSeq.get(target.msgId) ?? 1;
		const usedBefore = nextMsgSeq - 1;
		const remainingBudget = Math.max(0, QQ_MAX_REPLY_CHUNKS - usedBefore);
		const maxChunks = Math.min(chunks.length, forcePlain ? Math.min(1, remainingBudget) : remainingBudget);
		let useMarkdown = replyFormat !== "plain";
		let delivery = useMarkdown ? "markdown" : "plain";
		for (let i = 0; i < maxChunks; i++) {
			try {
				if (!useMarkdown) {
					await this.api.sendText(target, formatted.plain[i], nextMsgSeq++);
				} else {
					const fellBack = await this.sendMarkdownWithFallback(
						target,
						formatted.markdown[i],
						formatted.plain[i],
						nextMsgSeq,
						i === maxChunks - 1 ? keyboard : undefined,
					);
					nextMsgSeq += fellBack ? 2 : 1;
					if (fellBack) {
						useMarkdown = false;
						delivery = "plain-fallback";
					}
				}
				this.nextMsgSeq.set(target.msgId, nextMsgSeq);
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
		this.debugLog(`reply delivery=${delivery} chunks=${sentChunks}${keyboard ? ` keyboardRows=${keyboard.content.rows.length}` : ""}`);
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
		keyboard?: QQKeyboard,
	): Promise<boolean> {
		if (!this.api) throw new Error("QQ API is not ready");
		try {
			await this.api.sendMarkdown(target, markdown, msgSeq, keyboard);
			return false;
		} catch (err) {
			if (!(err instanceof QQApiError) || !canFallbackFromMarkdown(err)) throw err;
			this.debugLog(`markdown rejected; falling back to plain text (status ${err.status}${err.code != null ? `, code ${err.code}` : ""})`);
			// A rejected HTTP response did not deliver a QQ message. Use the next
			// sequence number and keep subsequent chunks plain for this reply. The
			// page navigation command remains in the body as a text fallback.
			await this.api.sendText(target, plain, msgSeq + 1);
			return true;
		}
	}

	private hasMediaReplyCapacity(msgId: string): boolean {
		return (this.nextMsgSeq.get(msgId) ?? 1) < QQ_MAX_REPLY_CHUNKS;
	}

	private reserveMediaReplySequence(msgId: string): number | undefined {
		const next = this.nextMsgSeq.get(msgId) ?? 1;
		// Keep at least one deterministic plain-text slot for the final acknowledgement.
		if (next >= QQ_MAX_REPLY_CHUNKS) return undefined;
		this.nextMsgSeq.set(msgId, next + 1);
		return next;
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
			const seq = this.nextMsgSeq.get(msg.id) ?? 1;
			await this.api.sendText(target, "当前消息较多，请稍后重试。需要中止排队中的任务可发送 /stop。", seq);
			this.nextMsgSeq.set(msg.id, seq + 1);
		} catch (err) {
			this.debugLog(`busy notice failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async sendProgressAck(msg: QQInboundMessage): Promise<void> {
		if (!this.api || msg.fake) return;
		if (this.progressAckSent.has(msg.id)) return;
		const used = (this.nextMsgSeq.get(msg.id) ?? 1) - 1;
		if (used >= QQ_MAX_REPLY_CHUNKS) return;
		// Reserve seq before awaiting so a concurrent final reply cannot collide.
		const seq = this.nextMsgSeq.get(msg.id) ?? 1;
		this.nextMsgSeq.set(msg.id, seq + 1);
		this.progressAckSent.add(msg.id);
		const target: QQReplyTarget = {
			type: msg.type,
			userOpenId: msg.userOpenId,
			groupOpenId: msg.groupOpenId,
			msgId: msg.id,
			createdAt: Date.now(),
		};
		try {
			// Plain text keeps the ack cheap and avoids spending a Markdown attempt.
			await this.api.sendText(target, "已收到，正在处理。需要中止请发送 /stop。", seq);
			this.debugLog(`progress ack sent for msg_id=${sanitizeLogValue(msg.id)} seq=${seq}`);
		} catch (err) {
			this.debugLog(`progress ack failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// --- Status / debug ------------------------------------------------------

	statusText(): string {
		const lines = [
			`pi-qqbot: ${this.config.enabled ? "enabled" : "disabled"} (appId ${maskAppId(this.config.appId)}, ${this.config.sandbox ? "sandbox" : "prod"})`,
			`connection: ${this.state}${this.stateDetail ? ` (${this.stateDetail})` : ""}`,
			`queue: ${this.waitingMessageCount()}`,
			`session: isolated (${this.conversations ? "ready" : "not ready"}, resident ${this.conversations?.residentCount ?? 0})`,
			`commands: ${this.config.commands.enabled ? "on (SDK control)" : "off"}`,
			`process: ${this.config.showProcess ? "on" : "off"}`,
			`progress ack: ${this.config.progress.enabled ? `on (${this.config.progress.ackAfterMs}ms)` : "off"}`,
			`reply format: ${this.config.replyFormat}`,
			`media inbound: ${this.config.media.enabled ? "on" : "off"}`,
			`media outbound: ${this.config.outboundMedia.enabled ? "on" : "off"}`,
			`active: ${this.activeTargetLabel()}`,
			`attachment: ${this.activeAttachmentStatus ?? "idle"}`,
			`outbound media: ${this.activeOutboundMediaStatus ?? "idle"}`,
			`last inbound: ${this.lastInbound ? new Date(this.lastInbound.at).toLocaleTimeString() : "none"}`,
			`last outbound: ${this.lastOutbound ? new Date(this.lastOutbound.at).toLocaleTimeString() : "none"}`,
		];
		if (this.lastAttachmentError) lines.push(`last attachment error: ${this.lastAttachmentError}`);
		if (this.lastOutboundMediaError) lines.push(`last outbound media error: ${this.lastOutboundMediaError}`);
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
		if (this.lastOutboundMediaError) lines.push(`last outbound media error: ${this.lastOutboundMediaError}`);
		if (this.lastError) lines.push(`last error: ${this.lastError}`);
		return lines.length ? lines.join("\n") : "no QQBot events yet";
	}

	private waitingMessageCount(): number {
		return this.queue.size + (this.activeConversation?.pendingCount ?? 0);
	}

	private activeTargetLabel(): string {
		if (!this.activeTarget) return "none";
		return this.activeTarget.type === "group"
			? `group:${this.activeTarget.groupOpenId}`
			: `private:${this.activeTarget.userOpenId}`;
	}

	private notify(text: string, level: "info" | "warning" | "error"): void {
		const ctx = this.ctx;
		if (!ctx) return;
		try {
			// hasUI/ui getters assert that the extension session is still active.
			// After /new, /resume, /fork, or /reload the cached ctx is stale and
			// must not crash the process-level QQ gateway.
			if (ctx.hasUI) ctx.ui.notify(text, level);
		} catch {
			this.ctx = undefined;
		}
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
			queueSize: this.waitingMessageCount(),
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

function replyTargetFor(msg: QQInboundMessage): QQReplyTarget {
	return {
		type: msg.type,
		userOpenId: msg.userOpenId,
		groupOpenId: msg.groupOpenId,
		msgId: msg.id,
		createdAt: Date.now(),
	};
}

function extractQQCorrelationId(text: string): string | undefined {
	return text.match(/\[QQ [^\]\r\n]*\bref=([a-f0-9]{24})\]/i)?.[1]?.toLowerCase();
}

export function suggestThinkingLevel(input: string, levels: readonly string[]): string | undefined {
	const normalizedInput = normalizeThinkingLevel(input);
	if (!normalizedInput) return undefined;

	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	let tied = false;
	for (const level of levels) {
		const candidate = normalizeThinkingLevel(level);
		if (!candidate) continue;
		const distance = thinkingLevelDistance(normalizedInput, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
			tied = false;
		} else if (distance === bestDistance) {
			tied = true;
		}
	}
	if (!best || tied) return undefined;
	const threshold = Math.max(1, Math.ceil(Math.max(normalizedInput.length, best.length) / 3));
	return bestDistance <= threshold ? best : undefined;
}

function thinkingLevelDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		for (let index = 0; index <= right.length; index++) previous[index] = current[index];
	}
	return previous[right.length] ?? left.length;
}

function modelMatches(model: QQModelInfo, query: string): boolean {
	const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
	return haystack.includes(query);
}

function rankModels(models: QQModelInfo[], query: string): QQModelInfo[] {
	return [...models].sort((left, right) => {
		if (query) {
			const leftId = `${left.provider}/${left.id}`.toLowerCase();
			const rightId = `${right.provider}/${right.id}`.toLowerCase();
			const leftScore = leftId === query ? 0 : leftId.startsWith(query) ? 1 : leftId.includes(query) ? 2 : 3;
			const rightScore = rightId === query ? 0 : rightId.startsWith(query) ? 1 : rightId.includes(query) ? 2 : 3;
			if (leftScore !== rightScore) return leftScore - rightScore;
		}
		return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
	});
}

function sessionMatches(session: QQSessionInfo, query: string): boolean {
	const preview = humanizeSessionPreview(session.firstMessage);
	const haystack = `${session.name ?? ""} ${preview} ${humanizeSessionPreview(session.allMessagesText)}`.toLowerCase();
	return haystack.includes(query);
}

function formatSessionLine(session: QQSessionInfo, index: number, currentId: string): string {
	const title = escapeMarkdownInline(sessionDisplayTitle(session));
	const current = session.id === currentId ? " · 当前" : "";
	const preview = humanizeSessionPreview(session.firstMessage);
	const summary = preview && preview !== session.name ? `\n   摘要：${escapeMarkdownInline(preview)}` : "";
	return `${index + 1}. **${title}**${current}\n   \`${shortId(session.id)}\` · ${formatSessionTime(session.modified)} · ${session.messageCount} 条消息${summary}`;
}

function sessionDisplayTitle(session: QQSessionInfo): string {
	if (session.name?.trim()) return session.name.trim();
	return humanizeSessionPreview(session.firstMessage) || "未命名会话";
}

function sessionButtonLabel(session: QQSessionInfo): string {
	const title = sessionDisplayTitle(session);
	if (session.name?.trim()) return title.slice(0, 14);
	// Unnamed sessions: keep the short id scannable, optionally with a tiny hint.
	const id = shortId(session.id);
	const preview = humanizeSessionPreview(session.firstMessage);
	if (!preview) return id;
	const hint = preview.slice(0, 8);
	return `${hint}·${id}`.slice(0, 14);
}

function formatSessionTime(value: Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function shortId(value: string): string {
	const compact = value.replace(/[^a-zA-Z0-9]/g, "");
	// UUIDv7 starts with a timestamp, so its first eight characters commonly
	// collide for sessions created close together. The random suffix is safer.
	return compact.slice(-8) || "unknown";
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/[\\`*_[\]~]/g, "\\$&");
}

function sanitizeCommandError(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
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

function formatDeliverySummary(records: readonly QQOutboundDeliveryRecord[]): string {
	if (!records.length) return "";
	const lines = records.map((record) => {
		if (record.status === "sent") return `- 已发送：${escapeMarkdownInline(record.filename)}`;
		if (record.status === "unknown") return `- 发送结果未知：${escapeMarkdownInline(record.filename)}（${record.errorCode ?? "media_send_unknown"}）`;
		return `- 未发送：${escapeMarkdownInline(record.filename)}（${record.errorCode ?? "outbound_failed"}）`;
	});
	return `**QQ 文件交付结果**\n\n${lines.join("\n")}`;
}

function maskOpenId(value: string): string {
	if (value.length <= 12) return `${value.slice(0, 3)}…${value.slice(-3)}`;
	return `${value.slice(0, 6)}…${value.slice(-6)}`;
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
	return `${prompt}\n\n<qq-outbound-media-guidance>\n当用户明确要求把电脑上的本地图片或文件发送、上传或传给当前 QQ 会话时，必须调用 qq_send_local_file；在最终文本中给出本地路径、Markdown 图片或 URL 不等于发送。只有工具返回 QQ API 已确认成功后，才能说文件已发送；工具失败时必须如实说明未发送。不要调用该工具来回答仅查看、分析或告知路径的请求。\n</qq-outbound-media-guidance>\n\n<qq-reply-guidance>\n以下要求仅约束最终回答的呈现，不改变用户任务本身：请为手机 QQ 聊天界面组织最终回答，先直接给出答案或结论，删除寒暄和“好问题”等填充语；短回答不要强加标题；普通回答按“结论 → 关键点或步骤 → 必要注意事项”组织。每段只表达一个主题，段落简短；并列信息用无序列表，操作流程用有序列表，列表不要超过两层。仅对关键字使用粗体，风险或限制使用带文字标签的引用块（如“⚠️ 注意”）。避免宽表格，优先改成列表；代码仅保留必要、可复制的片段。不要添加“执行过程”章节，插件会在需要时附加执行摘要。输出 QQ 支持的简洁 Markdown，不要为了装饰堆叠标题、分割线或 Emoji。\n</qq-reply-guidance>`;
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
