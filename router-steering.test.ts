import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// pi uses jiti to load extension TypeScript (including extensionless local imports).
// Resolve that same loader from the required pi peer instead of adding a test-only dependency.
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRequire = createRequire(piEntry);
const jitiEntry = piRequire.resolve("jiti");
const { createJiti } = await import(pathToFileURL(jitiEntry).href);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { normalizeConfig } = await jiti.import("./config.ts") as typeof import("./config.ts");
const { MessageQueue } = await jiti.import("./queue.ts") as typeof import("./queue.ts");
const { QQAgentSession } = await jiti.import("./qq-session.ts") as typeof import("./qq-session.ts");
const { PiQQBotRuntime, suggestThinkingLevel } = await jiti.import("./router.ts") as typeof import("./router.ts");

type Inbound = import("./types.ts").QQInboundMessage;
type Image = import("./types.ts").QQImageContent;
type RunObserver = import("./qq-session.ts").QQAgentRunObserver;
type TerminalEvent = import("./types.ts").QQTerminalEvent;

class FakeAgentSession {
	streaming = false;
	supportsVision = true;
	deferFirstRunSteers = false;
	aborted = false;
	abortCalls = 0;
	clearCalls = 0;
	boundDelivery: unknown;
	readonly runs: Array<{ prompt: string; images: Image[] }> = [];
	readonly steers: Array<{ prompt: string; images: Image[] }> = [];
	private pendingSteers: Array<{ prompt: string; images: Image[] }> = [];
	private releaseCurrent?: () => void;

	isStreaming(): boolean {
		return this.streaming;
	}

	supportsImages(): boolean {
		return this.supportsVision;
	}

	bindOutboundDelivery(value?: unknown): void {
		this.boundDelivery = value;
	}

	async run(prompt: string, images: Image[], observer?: RunObserver): Promise<{ text: string; tools: [] }> {
		assert.equal(this.streaming, false, "fake session received overlapping run() calls");
		this.streaming = true;
		this.aborted = false;
		this.runs.push({ prompt, images });
		observer?.({ kind: "agent_start" });
		observer?.({ kind: "user_message", text: prompt });
		await new Promise<void>((resolve) => {
			this.releaseCurrent = resolve;
		});
		this.releaseCurrent = undefined;
		if (this.aborted) {
			this.streaming = false;
			return { text: "", tools: [] };
		}

		const delivered = this.deferFirstRunSteers && this.runs.length === 1
			? []
			: this.pendingSteers.splice(0);
		for (const steer of delivered) observer?.({ kind: "user_message", text: steer.prompt });
		observer?.({ kind: "assistant_start" });
		observer?.({ kind: "assistant_delta", delta: "aggregate final" });
		observer?.({ kind: "assistant_end" });
		this.streaming = false;
		return { text: "aggregate final", tools: [] };
	}

	async steer(prompt: string, images: Image[]): Promise<void> {
		if (!this.streaming) throw new Error("fake session is no longer streaming");
		const entry = { prompt, images };
		this.steers.push(entry);
		this.pendingSteers.push(entry);
	}

	clearPendingMessages(): number {
		this.clearCalls++;
		const removed = this.pendingSteers.length;
		this.pendingSteers.length = 0;
		return removed;
	}

	pendingMessageCount(): number {
		return this.pendingSteers.length;
	}

	async abort(): Promise<void> {
		this.abortCalls++;
		this.aborted = true;
		this.streaming = false;
		this.releaseCurrent?.();
	}

	release(): void {
		assert.ok(this.releaseCurrent, "no fake run is waiting for release");
		this.releaseCurrent();
	}
}

class FakeAttachmentPipeline {
	readonly preparedIds: string[] = [];
	readonly cleanedIds: string[] = [];
	readonly delayMs: number;
	constructor(delayMs = 0) {
		this.delayMs = delayMs;
	}

	async prepare(msg: Inbound, signal: AbortSignal): Promise<import("./types.ts").PreparedQQMessage> {
		if (this.delayMs) await abortableDelay(this.delayMs, signal);
		if (signal.aborted) throw signal.reason;
		this.preparedIds.push(msg.id);
		const correlationId = correlationFor(msg.id);
		const images: Image[] = [];
		const resources: import("./types.ts").PreparedAttachment[] = [];
		for (const attachment of msg.attachments) {
			if (attachment.contentType.startsWith("image/")) {
				images.push({ type: "image", data: "AA==", mimeType: "image/png" });
				resources.push({ kind: "image", filename: attachment.filename, status: "ready", mimeType: "image/png" });
			} else if (attachment.contentType.startsWith("audio/")) {
				resources.push({ kind: "voice", filename: attachment.filename, status: "ready", transcript: "voice text", source: "qq-asr" });
			} else {
				resources.push({ kind: "document", filename: attachment.filename, status: "ready", extractedText: "document text" });
			}
		}
		let cleaned = false;
		return {
			correlationId,
			prompt: `[QQ private user=${msg.userOpenId} message=${msg.id} ref=${correlationId}]\n\n${msg.text || resources.map((resource) => resource.kind).join(" ")}`,
			images,
			resources,
			cleanup: async () => {
				if (cleaned) return;
				cleaned = true;
				this.cleanedIds.push(msg.id);
			},
		};
	}
}

class FakeRegistry {
	readonly sessions: Map<string, FakeAgentSession>;
	constructor(sessions: Map<string, FakeAgentSession>) {
		this.sessions = sessions;
	}
	get residentCount(): number {
		return this.sessions.size;
	}
	async get(msg: Inbound): Promise<FakeAgentSession> {
		const session = this.sessions.get(keyFor(msg));
		if (!session) throw new Error(`missing fake session for ${keyFor(msg)}`);
		return session;
	}
	peek(msg: Inbound): FakeAgentSession | undefined {
		return this.sessions.get(keyFor(msg));
	}
	async dispose(): Promise<void> {}
}

class DelayedRegistry extends FakeRegistry {
	readonly getCalls: string[] = [];
	private readonly ready: Promise<void>;
	private releaseReady!: () => void;
	constructor(sessions: Map<string, FakeAgentSession>) {
		super(sessions);
		this.ready = new Promise<void>((resolve) => {
			this.releaseReady = resolve;
		});
	}
	async get(msg: Inbound): Promise<FakeAgentSession> {
		this.getCalls.push(msg.id);
		await this.ready;
		return super.get(msg);
	}
	release(): void {
		this.releaseReady();
	}
}

function createHarness(
	sessions: Map<string, FakeAgentSession>,
	options: { maxQueueSize?: number; pipelineDelayMs?: number } = {},
): {
	runtime: InstanceType<typeof PiQQBotRuntime>;
	events: TerminalEvent[];
	pipeline: FakeAttachmentPipeline;
} {
	const config = normalizeConfig({
		enabled: true,
		appId: "test",
		clientSecret: "test",
		maxQueueSize: options.maxQueueSize ?? 20,
		progress: { enabled: false },
		commands: { enabled: true },
	});
	const runtime = new PiQQBotRuntime(config);
	const events: TerminalEvent[] = [];
	const pipeline = new FakeAttachmentPipeline(options.pipelineDelayMs ?? 0);
	Object.defineProperty(runtime, "conversations", { value: new FakeRegistry(sessions), writable: true, configurable: true });
	Object.defineProperty(runtime, "attachmentPipeline", { value: pipeline, configurable: true });
	runtime.attachObserver({ onEvent: (event) => events.push(event), dispose() {} });
	return { runtime, events, pipeline };
}

function message(id: string, userOpenId: string, text: string, attachments: Inbound["attachments"] = []): Inbound {
	return {
		id,
		type: "private",
		text,
		userOpenId,
		attachments,
		raw: { test: true },
		receivedAt: Date.now(),
		fake: true,
	};
}

function correlationFor(id: string): string {
	return createHash("sha256").update(`test\0${id}`).digest("hex").slice(0, 24);
}

function keyFor(msg: Inbound): string {
	return msg.type === "private" ? `private:${msg.userOpenId}` : `group:${msg.groupOpenId ?? ""}`;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	assert.ok(predicate(), `timed out waiting for ${label}`);
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

// Queue extraction keeps cross-conversation FIFO order while preserving the
// arrival order of messages moved into the active steering inbox.
{
	const queue = new MessageQueue(5);
	const a1 = message("queue-a1", "A", "a1");
	const b1 = message("queue-b1", "B", "b1");
	const a2 = message("queue-a2", "A", "a2");
	assert.equal(queue.enqueue(a1), true);
	assert.equal(queue.enqueue(b1), true);
	assert.equal(queue.enqueue(a2), true);
	assert.deepEqual(queue.takeWhere((item) => item.userOpenId === "A").map((item) => item.id), ["queue-a1", "queue-a2"]);
	assert.equal(queue.dequeue()?.id, "queue-b1");
}

// The QQ session wrapper delegates to Pi's native steering and queue-clearing APIs.
{
	const wrapper = new QQAgentSession();
	const calls: Array<{ prompt: string; images: Image[] }> = [];
	let cleared = false;
	const coreSession = {
		isStreaming: true,
		pendingMessageCount: 2,
		async steer(prompt: string, images: Image[]) {
			calls.push({ prompt, images });
		},
		clearQueue() {
			cleared = true;
		},
	};
	Object.defineProperty(wrapper, "runtime", { value: { session: coreSession }, writable: true });
	await wrapper.steer("native steer", [{ type: "image", data: "AA==", mimeType: "image/png" }]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].images.length, 1);
	assert.equal(wrapper.pendingMessageCount(), 2);
	assert.equal(wrapper.clearPendingMessages(), 2);
	assert.equal(cleared, true);
}

// Thinking levels follow the SDK's model-specific list, including the newer
// `max` level, and invalid input remains a no-op with a useful typo suggestion.
{
	const wrapper = new QQAgentSession();
	let currentLevel = "medium";
	const coreSession = {
		get thinkingLevel() {
			return currentLevel;
		},
		getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		setThinkingLevel(level: string) {
			currentLevel = level;
		},
	};
	Object.defineProperty(wrapper, "runtime", { value: { session: coreSession }, writable: true });

	assert.equal(wrapper.setThinkingLevel(" MAX "), "max");
	assert.equal(currentLevel, "max");
	assert.throws(() => wrapper.setThinkingLevel("xhight"), /当前模型不支持思考等级/);
	assert.equal(currentLevel, "max");
	assert.equal(suggestThinkingLevel("xhight", wrapper.availableThinkingLevels()), "xhigh");
	assert.equal(suggestThinkingLevel("xhiht", wrapper.availableThinkingLevels()), "xhigh");
	assert.equal(suggestThinkingLevel("not-a-level", wrapper.availableThinkingLevels()), undefined);
}

// Text plus image, voice, and document inputs all steer the same native run;
// only one aggregate answer is passively replied to the latest delivered input.
{
	const session = new FakeAgentSession();
	const { runtime, events, pipeline } = createHarness(new Map([["private:A", session]]), { pipelineDelayMs: 2 });
	const root = message("same-root", "A", "start a long task");
	const image = message("same-image", "A", "", [{ contentType: "image/png", filename: "screen.png" }]);
	const voice = message("same-voice", "A", "", [{ contentType: "audio/ogg", filename: "voice.ogg" }]);
	const document = message("same-document", "A", "", [{ contentType: "file", filename: "notes.txt" }]);
	runtime.handleInbound(root);
	await waitFor(() => session.streaming, "initial same-conversation run");
	runtime.handleInbound(image);
	runtime.handleInbound(voice);
	runtime.handleInbound(document);
	await waitFor(() => session.steers.length === 3, "three rich-media steering submissions");
	assert.equal(events.some((event) => event.kind === "reply_start"), false, "old answer must not be sent before steers settle");
	assert.equal(session.runs.length, 1);
	assert.equal(session.steers[0].images.length, 1);
	assert.equal(session.steers[1].images.length, 0);
	assert.equal(session.steers[2].images.length, 0);
	session.release();
	await waitFor(() => runtime.isIdle(), "same-conversation aggregate completion");
	const replies = events.filter((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start");
	assert.deepEqual(replies.map((event) => event.messageId), ["same-document"]);
	assert.deepEqual(events.filter((event) => event.kind === "steered").map((event) => event.messageId), ["same-image", "same-voice", "same-document"]);
	assert.deepEqual([...pipeline.cleanedIds].sort(), ["same-document", "same-image", "same-root", "same-voice"].sort());
	await runtime.stop();
}

// If asynchronous attachment preparation finishes after the current low-level
// Pi run settles, it continues the same aggregate task as a new base turn. The
// intermediate old answer is still suppressed and the image payload is retained.
{
	const session = new FakeAgentSession();
	const { runtime, events } = createHarness(new Map([["private:A", session]]), { pipelineDelayMs: 40 });
	runtime.handleInbound(message("prep-root", "A", "root task"));
	await waitFor(() => session.streaming, "attachment-continuation root run");
	runtime.handleInbound(message("prep-image", "A", "", [{ contentType: "image/png", filename: "late.png" }]));
	session.release();
	await waitFor(() => session.runs.length === 2 && session.streaming, "post-settle attachment continuation");
	assert.equal(session.steers.length, 0);
	assert.equal(session.runs[1].images.length, 1);
	assert.equal(events.some((event) => event.kind === "reply_start"), false);
	session.release();
	await waitFor(() => runtime.isIdle(), "attachment continuation completion");
	const replyIds = events
		.filter((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start")
		.map((event) => event.messageId);
	assert.deepEqual(replyIds, ["prep-image"]);
	await runtime.stop();
}

// A steer queued in Pi's narrow post-poll/pre-settled window is not lost or
// falsely treated as delivered: it becomes the next base run without an old reply.
{
	const session = new FakeAgentSession();
	session.deferFirstRunSteers = true;
	const { runtime, events } = createHarness(new Map([["private:A", session]]));
	runtime.handleInbound(message("late-root", "A", "root task"));
	await waitFor(() => session.streaming, "late-race root run");
	runtime.handleInbound(message("late-steer", "A", "late correction"));
	await waitFor(() => session.steers.length === 1, "late-race steering submission");
	session.release();
	await waitFor(() => session.runs.length === 2 && session.streaming, "late steer continuation run");
	assert.equal(events.some((event) => event.kind === "reply_start"), false);
	assert.ok(session.clearCalls > 0);
	session.release();
	await waitFor(() => runtime.isIdle(), "late steer continuation completion");
	const replyIds = events
		.filter((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start")
		.map((event) => event.messageId);
	assert.deepEqual(replyIds, ["late-steer"]);
	await runtime.stop();
}

// The pump marks a run busy before asynchronous session initialization. Messages
// arriving in that window cannot start a second run; same-scope items are drained
// into steering once initialization completes and other scopes remain FIFO.
{
	const sessionA = new FakeAgentSession();
	const sessionB = new FakeAgentSession();
	const sessions = new Map([
		["private:A", sessionA],
		["private:B", sessionB],
	]);
	const { runtime, events } = createHarness(sessions);
	const registry = new DelayedRegistry(sessions);
	Object.defineProperty(runtime, "conversations", { value: registry, writable: true, configurable: true });
	runtime.handleInbound(message("init-a-root", "A", "root while initializing"));
	runtime.handleInbound(message("init-a-steer", "A", "same-scope follow-up"));
	runtime.handleInbound(message("init-b", "B", "other scope"));
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(registry.getCalls, ["init-a-root"]);
	assert.equal(sessionA.runs.length, 0);
	assert.equal(sessionB.runs.length, 0);
	registry.release();
	await waitFor(() => sessionA.streaming && sessionA.steers.length === 1, "post-init steering drain");
	assert.equal(sessionB.runs.length, 0);
	sessionA.release();
	await waitFor(() => sessionB.streaming, "post-init cross-scope FIFO run");
	sessionB.release();
	await waitFor(() => runtime.isIdle(), "post-init serialization completion");
	const replyIds = events
		.filter((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start")
		.map((event) => event.messageId);
	assert.deepEqual(replyIds, ["init-a-steer", "init-b"]);
	await runtime.stop();
}

// A different private conversation remains FIFO and cannot enter or retarget
// the active conversation's run.
{
	const sessionA = new FakeAgentSession();
	const sessionB = new FakeAgentSession();
	const { runtime, events } = createHarness(new Map([
		["private:A", sessionA],
		["private:B", sessionB],
	]));
	runtime.handleInbound(message("cross-a", "A", "task A"));
	await waitFor(() => sessionA.streaming, "conversation A run");
	runtime.handleInbound(message("cross-b", "B", "task B"));
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	assert.equal(sessionA.steers.length, 0);
	assert.equal(sessionB.runs.length, 0);
	sessionA.release();
	await waitFor(() => sessionB.streaming, "conversation B FIFO run");
	sessionB.release();
	await waitFor(() => runtime.isIdle(), "cross-conversation completion");
	const replyIds = events
		.filter((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start")
		.map((event) => event.messageId);
	assert.deepEqual(replyIds, ["cross-a", "cross-b"]);
	await runtime.stop();
}

// maxQueueSize applies to not-yet-delivered steering inputs as well as the
// external FIFO, so an active conversation cannot grow an unbounded side queue.
{
	const session = new FakeAgentSession();
	const { runtime, events, pipeline } = createHarness(new Map([["private:A", session]]), { maxQueueSize: 1 });
	runtime.handleInbound(message("limit-root", "A", "root"));
	await waitFor(() => session.streaming, "capacity root run");
	runtime.handleInbound(message("limit-accepted", "A", "accepted steer"));
	await waitFor(() => session.steers.length === 1, "accepted steering slot");
	runtime.handleInbound(message("limit-dropped", "A", "must be dropped"));
	assert.ok(events.some((event) => event.kind === "error" && event.stage === "queue" && event.messageId === "limit-dropped"));
	assert.equal(pipeline.preparedIds.includes("limit-dropped"), false);
	session.release();
	await waitFor(() => runtime.isIdle(), "capacity run completion");
	const finalReply = events.find((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start");
	assert.equal(finalReply?.messageId, "limit-accepted");
	await runtime.stop();
}

// /stop clears Pi's native steering queue, aborts the aggregate run, cleans all
// prepared inputs, and suppresses stale final replies from the stopped task.
{
	const session = new FakeAgentSession();
	const { runtime, events, pipeline } = createHarness(new Map([["private:A", session]]));
	runtime.handleInbound(message("stop-root", "A", "long task"));
	await waitFor(() => session.streaming, "stoppable root run");
	runtime.handleInbound(message("stop-steer", "A", "change the task"));
	await waitFor(() => session.steers.length === 1, "stoppable steer");
	runtime.handleInbound(message("stop-command", "A", "/stop"));
	await waitFor(() => session.abortCalls > 0, "session abort");
	await waitFor(() => runtime.isIdle(), "stopped runtime cleanup");
	await waitFor(
		() => events.some((event) => event.kind === "reply_start" && event.messageId === "stop-command"),
		"stop command reply",
	);
	assert.ok(session.clearCalls > 0);
	const replyIds = events
		.filter((event): event is Extract<TerminalEvent, { kind: "reply_start" }> => event.kind === "reply_start")
		.map((event) => event.messageId);
	assert.deepEqual(replyIds, ["stop-command"]);
	assert.deepEqual([...pipeline.cleanedIds].sort(), ["stop-root", "stop-steer"].sort());
	await runtime.stop();
}

console.log("router-steering.test.ts: ok");
