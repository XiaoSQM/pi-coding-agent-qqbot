/**
 * Persistent, isolated Pi runtime for QQ traffic.
 *
 * QQ sessions use Pi's AgentSessionRuntime so model changes, new sessions,
 * resume, naming, compaction, and abort are real SDK operations rather than
 * slash-prefixed prompts. Session files live in a QQ-only directory supplied
 * by the conversation registry; they never appear in the local TUI's normal
 * session list.
 *
 * Resource policy: QQ runtimes load the host's skills, MCP adapters, packages,
 * and other extensions so private QQ use has the same tooling surface as local
 * Pi. Recursion guard: pi-qqbot itself is excluded before load and filtered
 * again after load, so the isolated runtime never re-enters this extension.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

import type { QQOutboundDeliveryContext } from "./outbound-media";
import { formatBytes } from "./outbound-media";
import { extractFinalAssistantText } from "./user-facing";
import type { QQImageContent } from "./types";

export interface QQToolCall {
	toolCallId: string;
	name: string;
	args: unknown;
	isError: boolean;
}

export interface QQRunResult {
	text: string;
	tools: QQToolCall[];
}

export interface QQModelInfo {
	provider: string;
	id: string;
	name: string;
	input: string[];
	reasoning: boolean;
}

export interface QQSessionInfo {
	path: string;
	id: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type QQAgentRunEvent =
	| { kind: "assistant_start" }
	| { kind: "assistant_delta"; delta: string }
	| { kind: "assistant_end" }
	| { kind: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { kind: "tool_end"; toolCallId: string; toolName: string; isError: boolean };

export type QQAgentRunObserver = (event: QQAgentRunEvent) => void;

// Split so the literal never appears verbatim in the bundle path scan target.
const SDK_MARKER = "@earendil-works" + "/" + "pi-coding-agent";

/** Locate the installed pi SDK entry (dist/index.js) from the running process. */
export function resolveSdkEntry(): string {
	const candidates: string[] = [];
	if (process.argv[1]) {
		try {
			candidates.push(realpathSync(process.argv[1]));
		} catch {
			// ignore; fall back to the raw path
		}
		candidates.push(process.argv[1]);
	}
	for (const candidate of candidates) {
		const normalized = candidate.replaceAll("\\", "/");
		const index = normalized.lastIndexOf(SDK_MARKER);
		if (index >= 0) return `${normalized.slice(0, index + SDK_MARKER.length)}/dist/index.js`;
	}
	throw new Error("cannot locate pi SDK from process.argv[1]");
}

// biome-ignore lint/suspicious/noExplicitAny: SDK is imported dynamically by path.
let sdkPromise: Promise<any> | undefined;
// biome-ignore lint/suspicious/noExplicitAny: SDK is imported dynamically by path.
function loadSdk(): Promise<any> {
	if (!sdkPromise) sdkPromise = import(pathToFileURL(resolveSdkEntry()).href);
	return sdkPromise;
}

export async function loadResizeImage(): Promise<(
	inputBytes: Uint8Array,
	mimeType: string,
) => Promise<{ data: string; mimeType: string } | null>> {
	const sdk = await loadSdk();
	return sdk.resizeImage;
}

export class QQAgentSession {
	// biome-ignore lint/suspicious/noExplicitAny: runtime typing comes from the dynamic SDK.
	private runtime: any;
	private cwd = "";
	private sessionDir?: string;
	private persistent = true;
	private restore: "recent" | "new" = "recent";
	private disposed = false;
	private outboundDelivery?: QQOutboundDeliveryContext;

	/** Create the isolated runtime. Throws if the SDK/model cannot be loaded. */
	async init(
		cwd: string,
		options: { sessionDir?: string; persistent?: boolean; restore?: "recent" | "new" } = {},
	): Promise<void> {
		this.disposed = false;
		this.cwd = cwd;
		this.sessionDir = options.sessionDir;
		this.persistent = options.persistent !== false;
		this.restore = options.restore ?? "recent";
		const sdk = await loadSdk();
		const sessionManager = this.createInitialSessionManager(sdk);
		const createRuntime = async ({
			cwd: runtimeCwd,
			agentDir,
			sessionManager: manager,
			sessionStartEvent,
		}: {
			cwd: string;
			agentDir: string;
			sessionManager: unknown;
			sessionStartEvent?: unknown;
		}) => {
			// Read the host's global defaults once, then isolate all QQ-side changes
			// in memory. `/model` in QQ must never rewrite the local Pi default.
			const hostSettings = sdk.SettingsManager.create(runtimeCwd, agentDir);
			const globalSettings = hostSettings.getGlobalSettings();
			const extensionPaths = Array.isArray(globalSettings.extensions)
				? globalSettings.extensions.filter((value: unknown): value is string => typeof value === "string")
				: [];
			// Keep host skills/MCP/plugins available, but never re-load pi-qqbot.
			for (const pattern of PI_QQBOT_EXTENSION_EXCLUDES) {
				if (!extensionPaths.includes(pattern)) extensionPaths.push(pattern);
			}
			const isolatedSettings = sdk.SettingsManager.inMemory({
				...globalSettings,
				extensions: extensionPaths,
			});
			const services = await sdk.createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				settingsManager: isolatedSettings,
				resourceLoaderOptions: {
					// Load skills + packages + MCP/plugin extensions from the host agent.
					extensionsOverride: (base: {
						extensions: Array<{ path?: string; resolvedPath?: string }>;
						errors: Array<{ path: string; error: string }>;
						runtime: unknown;
					}) => ({
						...base,
						extensions: base.extensions.filter(
							(extension) =>
								!isPiQQBotExtensionPath(extension.path) && !isPiQQBotExtensionPath(extension.resolvedPath),
						),
					}),
				},
			});
			return {
				...(await sdk.createAgentSessionFromServices({
					services,
					sessionManager: manager,
					sessionStartEvent,
					customTools: [this.createOutboundMediaTool(sdk)],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: sdk.getAgentDir(),
			sessionManager,
		});
		await runtime.session.bindExtensions({});
		runtime.setRebindSession(async (session: { bindExtensions(options: object): Promise<void> }) => {
			await session.bindExtensions({});
		});
		if (this.disposed) {
			await runtime.dispose();
			return;
		}
		this.runtime = runtime;
	}

	isReady(): boolean {
		return !!this.runtime?.session && !this.disposed;
	}

	isStreaming(): boolean {
		return this.runtime?.session?.isStreaming === true;
	}

	bindOutboundDelivery(context?: QQOutboundDeliveryContext): void {
		this.outboundDelivery = context;
	}

	/** Run one QQ prompt to completion. Callers serialize prompt runs. */
	async run(prompt: string, images: QQImageContent[] = [], observer?: QQAgentRunObserver): Promise<QQRunResult> {
		const session = this.requireSession();
		const tools: QQToolCall[] = [];
		const toolIndexes = new Map<string, number>();
		let messages: unknown[] = [];
		const emit = (event: QQAgentRunEvent): void => {
			try {
				observer?.(event);
			} catch {
				// Terminal observation must never interfere with the isolated agent run.
			}
		};
		// biome-ignore lint/suspicious/noExplicitAny: event union comes from the dynamic SDK.
		const unsubscribe: () => void = session.subscribe((event: any) => {
			if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_start") {
				emit({ kind: "assistant_start" });
			} else if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta;
				if (typeof delta === "string" && delta) emit({ kind: "assistant_delta", delta });
			} else if (event?.type === "message_update" && event.assistantMessageEvent?.type === "text_end") {
				emit({ kind: "assistant_end" });
			} else if (event?.type === "tool_execution_start") {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${tools.length}`;
				const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
				toolIndexes.set(toolCallId, tools.length);
				tools.push({ toolCallId, name: toolName, args: event.args, isError: false });
				emit({ kind: "tool_start", toolCallId, toolName, args: event.args });
			} else if (event?.type === "tool_execution_end") {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
				const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
				const index = toolIndexes.get(toolCallId);
				if (index !== undefined) tools[index].isError = !!event.isError;
				emit({ kind: "tool_end", toolCallId, toolName, isError: !!event.isError });
			} else if (event?.type === "agent_end") {
				if (Array.isArray(event.messages)) messages = event.messages;
			}
		});
		try {
			await session.prompt(prompt, { images, source: "extension" });
		} finally {
			unsubscribe();
		}
		return { text: extractFinalAssistantText(messages), tools };
	}

	currentModel(): QQModelInfo | undefined {
		return toModelInfo(this.runtime?.session?.model);
	}

	availableModels(): QQModelInfo[] {
		const models = this.runtime?.services?.modelRegistry?.getAvailable?.();
		return Array.isArray(models) ? models.map(toModelInfo).filter((value): value is QQModelInfo => !!value) : [];
	}

	async setModel(provider: string, modelId: string): Promise<QQModelInfo> {
		const registry = this.runtime?.services?.modelRegistry;
		const model = registry?.find?.(provider, modelId);
		if (!model || !registry.getAvailable().some((available: { provider: string; id: string }) => available.provider === provider && available.id === modelId)) {
			throw new Error(`模型不存在或当前未配置认证：${provider}/${modelId}`);
		}
		await this.requireSession().setModel(model);
		const current = this.currentModel();
		if (!current) throw new Error("模型切换后无法读取当前模型");
		return current;
	}

	thinkingLevel(): string {
		return typeof this.runtime?.session?.thinkingLevel === "string" ? this.runtime.session.thinkingLevel : "off";
	}

	availableThinkingLevels(): string[] {
		const levels = this.runtime?.session?.getAvailableThinkingLevels?.();
		return Array.isArray(levels) ? levels : ["off"];
	}

	setThinkingLevel(level: string): string {
		const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
		if (!allowed.has(level)) throw new Error(`无效思考等级：${level}`);
		this.requireSession().setThinkingLevel(level);
		return this.thinkingLevel();
	}

	async newSession(name?: string): Promise<{ id: string; name?: string }> {
		this.assertIdle("新建会话");
		const result = await this.requireRuntime().newSession();
		if (result.cancelled) throw new Error("新建 QQ 会话已取消");
		const normalizedName = normalizeSessionName(name);
		if (normalizedName) this.requireSession().sessionManager.appendSessionInfo(normalizedName);
		return { id: this.sessionId(), ...(normalizedName ? { name: normalizedName } : {}) };
	}

	async listSessions(): Promise<QQSessionInfo[]> {
		if (!this.persistent || !this.sessionDir) return [];
		const sdk = await loadSdk();
		const sessions = await sdk.SessionManager.list(this.cwd, this.sessionDir);
		return sessions as QQSessionInfo[];
	}

	async resumeSession(path: string): Promise<{ id: string; name?: string }> {
		this.assertIdle("恢复会话");
		const allowed = await this.listSessions();
		const target = allowed.find((session) => session.path === path);
		if (!target) throw new Error("目标 QQ 会话不存在或不属于当前对话");
		const result = await this.requireRuntime().switchSession(target.path);
		if (result.cancelled) throw new Error("恢复 QQ 会话已取消");
		return { id: this.sessionId(), ...(this.sessionName() ? { name: this.sessionName() } : {}) };
	}

	setSessionName(name: string): string {
		const normalized = normalizeSessionName(name);
		if (!normalized) throw new Error("会话名称不能为空");
		this.requireSession().sessionManager.appendSessionInfo(normalized);
		return normalized;
	}

	sessionId(): string {
		const id = this.runtime?.session?.sessionId;
		return typeof id === "string" ? id : "";
	}

	sessionName(): string | undefined {
		const name = this.runtime?.session?.sessionManager?.getSessionName?.();
		return typeof name === "string" && name ? name : undefined;
	}

	sessionMessageCount(): number {
		const entries = this.runtime?.session?.sessionManager?.getEntries?.();
		return Array.isArray(entries)
			? entries.filter((entry: { type?: string }) => entry?.type === "message").length
			: 0;
	}

	async compact(instructions?: string): Promise<{ tokensBefore?: number }> {
		this.assertIdle("压缩会话");
		const result = await this.requireSession().compact(instructions?.trim() || undefined);
		return { tokensBefore: typeof result?.tokensBefore === "number" ? result.tokensBefore : undefined };
	}

	supportsImages(): boolean {
		return Array.isArray(this.runtime?.session?.model?.input) && this.runtime.session.model.input.includes("image");
	}

	async abort(): Promise<void> {
		try {
			await this.runtime?.session?.abort?.();
		} catch {
			// ignore abort errors during shutdown
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.outboundDelivery?.close();
		this.outboundDelivery = undefined;
		const runtime = this.runtime;
		this.runtime = undefined;
		try {
			await runtime?.dispose?.();
		} catch {
			// ignore dispose errors on shutdown
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamically imported SDK.
	private createOutboundMediaTool(sdk: any): any {
		const qqSession = this;
		return sdk.defineTool({
			name: "qq_send_local_file",
			label: "Send Local File to QQ",
			description: "Send one real local computer file to the QQ conversation that requested the current task. Use this when the QQ user explicitly asks to send/upload/transfer a local image or file. A local path, Markdown image, or URL in the final answer does not send the file. The target QQ user and reply metadata are securely bound by the plugin; provide only the local path.",
			parameters: Type.Object({
				path: Type.String({ description: "Local file path returned by a tool or explicitly provided by the user" }),
			}),
			async execute(_toolCallId: string, params: { path: string }) {
				const delivery = qqSession.outboundDelivery;
				if (!delivery) throw new Error("No active QQ delivery context (delivery_context_closed)");
				const record = await delivery.sendLocalFile(params.path, "auto");
				return {
					content: [{
						type: "text",
						text: `QQ API 已确认发送${record.kind === "image" ? "图片" : "文件"} ${record.filename}（${formatBytes(record.bytes)}）。`,
					}],
					details: { filename: record.filename, kind: record.kind, bytes: record.bytes, status: record.status },
				};
			},
		});
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamically imported SDK.
	private createInitialSessionManager(sdk: any): any {
		if (!this.persistent) return sdk.SessionManager.inMemory(this.cwd);
		if (!this.sessionDir) throw new Error("persistent QQ session requires a session directory");
		return this.restore === "recent"
			? sdk.SessionManager.continueRecent(this.cwd, this.sessionDir)
			: sdk.SessionManager.create(this.cwd, this.sessionDir);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamically imported SDK.
	private requireRuntime(): any {
		if (!this.runtime || this.disposed) throw new Error("QQ session runtime not initialized");
		return this.runtime;
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamically imported SDK.
	private requireSession(): any {
		return this.requireRuntime().session;
	}

	private assertIdle(action: string): void {
		if (this.isStreaming()) throw new Error(`当前 QQ 任务仍在执行，无法${action}；请先发送 /stop`);
	}
}

function toModelInfo(value: unknown): QQModelInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const model = value as {
		provider?: unknown;
		id?: unknown;
		name?: unknown;
		input?: unknown;
		reasoning?: unknown;
	};
	if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: typeof model.name === "string" && model.name ? model.name : model.id,
		input: Array.isArray(model.input) ? model.input.filter((input): input is string => typeof input === "string") : ["text"],
		reasoning: model.reasoning === true,
	};
}

function normalizeSessionName(value: string | undefined): string | undefined {
	const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, 80) : undefined;
}

/** Settings exclusions that prevent auto-discovery from enabling pi-qqbot again. */
const PI_QQBOT_EXTENSION_EXCLUDES = [
	"!**/pi-qqbot/**",
	"!**/pi-qqbot",
	"!**/@xsqm/pi-qqbot/**",
	"!**/@xsqm/pi-qqbot",
	"!extensions/pi-qqbot/**",
	"!extensions/pi-qqbot",
] as const;

/** True when a loaded extension path points at this QQ bridge itself. */
function isPiQQBotExtensionPath(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.replaceAll("\\", "/").toLowerCase();
	return (
		normalized.includes("/pi-qqbot/") ||
		normalized.endsWith("/pi-qqbot") ||
		normalized.includes("/@xsqm/pi-qqbot/") ||
		normalized.endsWith("/@xsqm/pi-qqbot")
	);
}
