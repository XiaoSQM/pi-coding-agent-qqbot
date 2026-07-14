/**
 * QQAgentSession: an isolated Pi agent session for QQ traffic.
 *
 * Why: the pi-qqbot extension runs inside the interactive Pi process. Injecting
 * QQ messages via pi.sendUserMessage() would pollute the local user's TUI
 * session. Instead we spin up a SEPARATE AgentSession (own history, own event
 * stream, own in-memory session) with the SDK, so QQ conversations never touch
 * the local session and can run in parallel with it.
 *
 * Recursion guard: the isolated session is created with `noExtensions: true`,
 * so it does NOT re-load pi-qqbot itself (which would otherwise start a second
 * QQ gateway).
 *
 * SDK resolution: extensions are loaded from ~/.pi/agent/extensions where the
 * bare package name "@earendil-works/pi-coding-agent" is not resolvable. We
 * locate the installed SDK from the running pi entrypoint (process.argv[1]) and
 * import it by absolute path.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
	for (const c of candidates) {
		const norm = c.replaceAll("\\", "/");
		const idx = norm.lastIndexOf(SDK_MARKER);
		if (idx >= 0) return `${norm.slice(0, idx + SDK_MARKER.length)}/dist/index.js`;
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
	// biome-ignore lint/suspicious/noExplicitAny: AgentSession typing comes from the dynamic SDK.
	private session: any;
	private disposed = false;

	/** Create the isolated session. Throws if the SDK/model cannot be loaded. */
	async init(cwd: string): Promise<void> {
		this.disposed = false;
		const sdk = await loadSdk();
		const loader = new sdk.DefaultResourceLoader({
			cwd,
			agentDir: sdk.getAgentDir(),
			noExtensions: true, // do not re-load pi-qqbot (avoids a second gateway)
		});
		await loader.reload();
		const { session } = await sdk.createAgentSession({
			cwd,
			resourceLoader: loader,
			sessionManager: sdk.SessionManager.inMemory(cwd),
		});
		if (this.disposed) {
			session.dispose();
			return;
		}
		this.session = session;
	}

	isReady(): boolean {
		return !!this.session && !this.disposed;
	}

	/**
	 * Run one prompt to completion on the isolated session and return the final
	 * assistant text plus the tool calls made during the run.
	 *
	 * Callers must serialize runs (one at a time); the router's queue does this.
	 */
	async run(prompt: string, images: QQImageContent[] = [], observer?: QQAgentRunObserver): Promise<QQRunResult> {
		if (!this.session) throw new Error("QQ session not initialized");
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
		const unsubscribe: () => void = this.session.subscribe((e: any) => {
			if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_start") {
				emit({ kind: "assistant_start" });
			} else if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
				const delta = e.assistantMessageEvent.delta;
				if (typeof delta === "string" && delta) emit({ kind: "assistant_delta", delta });
			} else if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_end") {
				emit({ kind: "assistant_end" });
			} else if (e?.type === "tool_execution_start") {
				const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : `tool-${tools.length}`;
				const toolName = typeof e.toolName === "string" ? e.toolName : "tool";
				toolIndexes.set(toolCallId, tools.length);
				tools.push({ toolCallId, name: toolName, args: e.args, isError: false });
				emit({ kind: "tool_start", toolCallId, toolName, args: e.args });
			} else if (e?.type === "tool_execution_end") {
				const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : "";
				const toolName = typeof e.toolName === "string" ? e.toolName : "tool";
				const index = toolIndexes.get(toolCallId);
				if (index !== undefined) tools[index].isError = !!e.isError;
				emit({ kind: "tool_end", toolCallId, toolName, isError: !!e.isError });
			} else if (e?.type === "agent_end") {
				if (Array.isArray(e.messages)) messages = e.messages;
			}
		});
		try {
			await this.session.prompt(prompt, { images, source: "extension" });
		} finally {
			unsubscribe();
		}
		return { text: extractFinalAssistantText(messages), tools };
	}

	supportsImages(): boolean {
		return Array.isArray(this.session?.model?.input) && this.session.model.input.includes("image");
	}

	async abort(): Promise<void> {
		try {
			await this.session?.abort?.();
		} catch {
			// ignore abort errors during shutdown
		}
	}

	dispose(): void {
		this.disposed = true;
		try {
			this.session?.dispose?.();
		} catch {
			// ignore dispose errors on shutdown
		}
		this.session = undefined;
	}
}

/** Last assistant message with non-empty text content. */
function extractFinalAssistantText(messages: unknown[]): string {
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
					!!p &&
					typeof p === "object" &&
					(p as { type?: string }).type === "text" &&
					typeof (p as { text?: unknown }).text === "string",
			)
			.map((p) => p.text)
			.join("");
	}
	return "";
}
