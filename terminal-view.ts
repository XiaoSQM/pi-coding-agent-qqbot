import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ConnectionState, QQConversationObserver, QQTerminalEvent } from "./types";

const WIDGET_KEY = "pi-qqbot-conversation";
const STATUS_KEY = "pi-qqbot";
const MAX_RENDER_LINES = 10;
const MAX_EVENTS = 40;
const MAX_INBOUND_CHARS = 2_000;
const MAX_ASSISTANT_CHARS = 8_000;
const UI_THROTTLE_MS = 80;

interface ViewLine {
	kind: "inbound" | "queue" | "attachment" | "outbound" | "run" | "assistant" | "tool" | "reply" | "error";
	text: string;
	at: number;
	messageId?: string;
	toolCallId?: string;
	state?: "running" | "success" | "error";
}

interface RuntimeStatus {
	connection: ConnectionState;
	detail?: string;
	queueSize: number;
	running: boolean;
	activeLabel?: string;
}

/**
 * A process-local, non-persistent view of the isolated QQ session.
 *
 * It only uses ctx.ui APIs: no messages are appended to the local Pi session,
 * so the mirrored QQ transcript never participates in the local model context.
 */
export class TerminalConversationView implements QQConversationObserver {
	private readonly ctx: ExtensionContext;
	private readonly lines: ViewLine[] = [];
	private runtime: RuntimeStatus = {
		connection: "disconnected",
		queueSize: 0,
		running: false,
	};
	private tui?: TUI;
	private component?: Component;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				const component = new ConversationWidget(this, theme);
				this.component = component;
				return component;
			},
			{ placement: "aboveEditor" },
		);
		this.updateStatus();
	}

	onEvent(event: QQTerminalEvent): void {
		if (this.disposed) return;
		this.applyEvent(event);
		this.trimLines();
		if (event.kind === "assistant_delta") this.scheduleRender();
		else this.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		try {
			this.ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Session replacement can invalidate ctx before dispose finishes.
		}
		this.tui = undefined;
		this.component = undefined;
		this.lines.length = 0;
	}

	getLines(): readonly ViewLine[] {
		return this.lines;
	}

	private applyEvent(event: QQTerminalEvent): void {
		switch (event.kind) {
			case "runtime_state":
				this.runtime = {
					connection: event.connection,
					detail: event.connection === "error" ? event.detail : undefined,
					queueSize: event.queueSize,
					running: event.running,
					activeLabel: event.activeLabel,
				};
				this.updateStatus();
				break;
			case "inbound": {
				const prefix = event.fake ? "[fake] " : "";
				const attachments = summarizeKinds(event.attachmentKinds);
				const text = bounded(sanitizeText(event.text), MAX_INBOUND_CHARS);
				this.push({
					kind: "inbound",
					text: `${prefix}${event.channel === "group" ? "QQ群" : "QQ"} ${shortOpenId(event.senderLabel)}${attachments ? `  ${attachments}` : ""}${text ? `  ${text}` : ""}`,
					at: event.at,
					messageId: event.messageId,
				});
				break;
			}
			case "queued":
				this.runtime.queueSize = event.queueSize;
				this.push({
					kind: "queue",
					text: `↳ queued (${event.queueSize})`,
					at: event.at,
					messageId: event.messageId,
				});
				this.updateStatus();
				break;
			case "attachment_start":
				this.push({
					kind: "attachment",
					text: `↓ ${event.attachmentKind} ${event.index}/${event.total}  ${singleLine(event.filename)}`,
					at: event.at,
					messageId: event.messageId,
					state: "running",
				});
				break;
			case "attachment_progress": {
				const current = this.findLatest("attachment", event.messageId, "running");
				if (current) {
					current.text = `↓ ${event.attachmentKind} ${event.index}/${event.total}  ${singleLine(event.filename)}  ${formatBytes(event.bytes ?? 0)}`;
					current.at = event.at;
				}
				break;
			}
			case "attachment_end":
			case "attachment_rejected": {
				const current = this.findLatest("attachment", event.messageId, "running");
				const ok = event.kind === "attachment_end" && event.status === "ready";
				const text = `${ok ? "✓" : "✗"} ${event.attachmentKind}  ${singleLine(event.filename)}${event.bytes ? `  ${formatBytes(event.bytes)}` : ""}${event.note ? `  ${bounded(singleLine(event.note), 160)}` : ""}`;
				if (current) {
					current.text = text;
					current.state = ok ? "success" : "error";
					current.at = event.at;
				} else {
					this.push({ kind: "attachment", text, at: event.at, messageId: event.messageId, state: ok ? "success" : "error" });
				}
				break;
			}
			case "outbound_start":
				this.push({
					kind: "outbound",
					text: `↑ ${event.mediaKind}  ${singleLine(event.filename)}  ${formatBytes(event.bytes)}  validating`,
					at: event.at,
					messageId: event.messageId,
					state: "running",
				});
				break;
			case "outbound_uploaded": {
				const current = this.findLatest("outbound", event.messageId, "running");
				if (current) {
					current.text = `↑ ${event.mediaKind}  ${singleLine(event.filename)}  ${formatBytes(event.bytes)}  uploaded`;
					current.at = event.at;
				}
				break;
			}
			case "outbound_sent":
			case "outbound_failed": {
				const current = this.findLatest("outbound", event.messageId, "running");
				const ok = event.kind === "outbound_sent";
				const suffix = ok ? "sent" : `${event.errorCode ?? "outbound_failed"}${event.note ? `  ${bounded(singleLine(event.note), 120)}` : ""}`;
				const text = `${ok ? "✓" : "✗"} ${event.mediaKind}  ${singleLine(event.filename)}  ${formatBytes(event.bytes)}  ${suffix}`;
				if (current) {
					current.text = text;
					current.state = ok ? "success" : "error";
					current.at = event.at;
				} else {
					this.push({ kind: "outbound", text, at: event.at, messageId: event.messageId, state: ok ? "success" : "error" });
				}
				break;
			}
			case "run_start":
				this.runtime.running = true;
				this.push({
					kind: "run",
					text: "Pi  processing…",
					at: event.at,
					messageId: event.messageId,
					state: "running",
				});
				this.updateStatus();
				break;
			case "assistant_start":
				this.push({
					kind: "assistant",
					text: "Pi  ",
					at: event.at,
					messageId: event.messageId,
					state: "running",
				});
				break;
			case "assistant_delta":
				this.appendAssistantDelta(event.messageId, event.delta, event.at);
				break;
			case "assistant_end": {
				const assistant = this.findLatest("assistant", event.messageId, "running");
				if (assistant) assistant.state = "success";
				break;
			}
			case "tool_start":
				this.push({
					kind: "tool",
					text: `🔧 ${event.toolName}  ${argSummary(event.args)}`.trimEnd(),
					at: event.at,
					messageId: event.messageId,
					toolCallId: event.toolCallId,
					state: "running",
				});
				break;
			case "tool_end": {
				const existing = this.findTool(event.toolCallId);
				if (existing) {
					existing.state = event.isError ? "error" : "success";
					existing.at = event.at;
				} else {
					this.push({
						kind: "tool",
						text: `🔧 ${event.toolName}`,
						at: event.at,
						messageId: event.messageId,
						toolCallId: event.toolCallId,
						state: event.isError ? "error" : "success",
					});
				}
				break;
			}
			case "reply_start":
				this.push({
					kind: "reply",
					text: event.fake ? `↗ fake reply (${event.chunks} chunk)` : `↗ sending QQ reply (${event.chunks} chunk)`,
					at: event.at,
					messageId: event.messageId,
					state: "running",
				});
				break;
			case "reply_end": {
				const reply = this.findLatest("reply", event.messageId, "running");
				if (reply) {
					const wasFake = reply.text.startsWith("↗ fake");
					reply.state = event.ok ? "success" : "error";
					reply.at = event.at;
					reply.text = event.ok
						? wasFake
							? `↗ fake reply captured (${event.sentChunks} chunk)`
							: `↗ QQ reply sent (${event.sentChunks} chunk)`
						: `↗ QQ reply failed${event.error ? `: ${singleLine(event.error)}` : ""}`;
				} else {
					this.push({
						kind: "reply",
						text: event.ok
							? `↗ QQ reply sent (${event.sentChunks} chunk)`
							: `↗ QQ reply failed${event.error ? `: ${singleLine(event.error)}` : ""}`,
						at: event.at,
						messageId: event.messageId,
						state: event.ok ? "success" : "error",
					});
				}
				if (!event.ok) this.updateStatus();
				break;
			}
			case "run_end": {
				this.runtime.running = false;
				const running = this.findLatest("run", event.messageId, "running");
				if (running) {
					running.state = "success";
					running.text = "Pi  run complete";
				}
				const assistant = this.findLatest("assistant", event.messageId, "running");
				if (assistant) assistant.state = "success";
				this.updateStatus();
				break;
			}
			case "error":
				this.push({
					kind: "error",
					text: `${event.stage}: ${bounded(singleLine(event.message), 500)}`,
					at: event.at,
					messageId: event.messageId,
					state: "error",
				});
				break;
		}
	}

	private appendAssistantDelta(messageId: string, delta: string, at: number): void {
		let line = this.findLatest("assistant", messageId);
		if (!line) {
			line = { kind: "assistant", text: "Pi  ", at, messageId, state: "running" };
			this.push(line);
		}
		line.text = bounded(line.text + sanitizeText(delta), MAX_ASSISTANT_CHARS, true);
		line.at = at;
	}

	private findTool(toolCallId: string): ViewLine | undefined {
		for (let i = this.lines.length - 1; i >= 0; i--) {
			if (this.lines[i].toolCallId === toolCallId) return this.lines[i];
		}
		return undefined;
	}

	private findLatest(
		kind: ViewLine["kind"],
		messageId?: string,
		state?: ViewLine["state"],
	): ViewLine | undefined {
		for (let i = this.lines.length - 1; i >= 0; i--) {
			const line = this.lines[i];
			if (line.kind !== kind) continue;
			if (messageId !== undefined && line.messageId !== messageId) continue;
			if (state !== undefined && line.state !== state) continue;
			return line;
		}
		return undefined;
	}

	private push(line: ViewLine): void {
		this.lines.push(line);
	}

	private trimLines(): void {
		if (this.lines.length > MAX_EVENTS) this.lines.splice(0, this.lines.length - MAX_EVENTS);
	}

	private scheduleRender(): void {
		if (this.renderTimer || this.disposed) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.requestRender();
		}, UI_THROTTLE_MS);
	}

	private requestRender(): void {
		if (this.disposed) return;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.component?.invalidate();
		this.tui?.requestRender();
	}

	private updateStatus(): void {
		if (this.disposed) return;
		const icon =
			this.runtime.connection === "connected"
				? "●"
				: this.runtime.connection === "connecting"
					? "◐"
					: this.runtime.connection === "error"
						? "✗"
						: "○";
		const active = this.runtime.activeLabel ? ` | ${shortOpenId(this.runtime.activeLabel)}` : "";
		const running = this.runtime.running ? " | processing" : "";
		const detail = this.runtime.detail ? ` | ${bounded(singleLine(this.runtime.detail), 80)}` : "";
		const color: ThemeColor =
			this.runtime.connection === "connected"
				? "success"
				: this.runtime.connection === "error"
					? "error"
					: this.runtime.connection === "connecting"
						? "warning"
						: "dim";
		const text = `QQBot ${icon} ${this.runtime.connection} | queue ${this.runtime.queueSize}${running}${active}${detail}`;
		try {
			this.ctx.ui.setStatus(STATUS_KEY, this.ctx.ui.theme.fg(color, text));
		} catch {
			// Ignore stale UI contexts after local session replacement.
		}
	}
}

class ConversationWidget implements Component {
	private readonly view: TerminalConversationView;
	private readonly theme: Theme;
	private cachedWidth?: number;
	private cachedSignature?: string;
	private cachedLines?: string[];

	constructor(view: TerminalConversationView, theme: Theme) {
		this.view = view;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const source = this.view.getLines();
		const signature = source
			.map((line) => `${line.kind}:${line.state ?? ""}:${line.at}:${line.text}`)
			.join("\u0000");
		if (this.cachedLines && this.cachedWidth === width && this.cachedSignature === signature) {
			return this.cachedLines;
		}

		const rendered: string[] = [];
		for (const line of source) {
			const text = styleLine(line, this.theme);
			for (const wrapped of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
				rendered.push(` ${truncateToWidth(wrapped, Math.max(1, width - 1), "…")}`);
			}
		}
		this.cachedLines = rendered.slice(-MAX_RENDER_LINES);
		this.cachedWidth = width;
		this.cachedSignature = signature;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedSignature = undefined;
		this.cachedLines = undefined;
	}
}

function styleLine(line: ViewLine, theme: Theme): string {
	const time = new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const state =
		line.state === "running"
			? theme.fg("warning", " …")
			: line.state === "success"
				? theme.fg("success", " ✓")
				: line.state === "error"
					? theme.fg("error", " ✗")
					: "";
	const color: ThemeColor =
		line.kind === "inbound"
			? "accent"
			: line.kind === "error"
				? "error"
				: line.kind === "tool"
					? "toolTitle"
					: line.kind === "assistant"
						? "text"
						: "muted";
	return `${theme.fg("dim", time)} ${theme.fg(color, line.text)}${state}`;
}

function summarizeKinds(kinds: string[]): string {
	if (!kinds.length) return "";
	const counts = new Map<string, number>();
	for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	return `[${[...counts].map(([kind, count]) => `${kind}×${count}`).join(", ")}]`;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	return `${Math.max(0, Math.round(bytes / 1024))} KiB`;
}

function argSummary(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = a.command ?? a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query ?? a.url;
	let text: string;
	try {
		text = typeof pick === "string" ? pick : (JSON.stringify(a) ?? "");
	} catch {
		text = "[unserializable arguments]";
	}
	return bounded(singleLine(text ?? ""), 120);
}

function sanitizeText(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function singleLine(text: string): string {
	return sanitizeText(text).replace(/\s+/g, " ").trim();
}

function bounded(text: string, max: number, keepTail = false): string {
	if (text.length <= max) return text;
	return keepTail ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`;
}

export function shortOpenId(value: string): string {
	const normalized = singleLine(value);
	if (normalized.length <= 12) return normalized;
	return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}
