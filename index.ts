/**
 * pi-qqbot: connect official QQ text and rich-media events to Pi.
 *
 * Lifecycle:
 *  - Commands are registered immediately (in the factory).
 *  - The QQ runtime (sockets/timers + an ISOLATED agent session) starts on
 *    /qqbot-start, or in session_start only when autoStart is enabled.
 *  - All runtime and terminal-view resources are torn down in session_shutdown.
 *
 * Isolation: QQ messages are handled by a separate SDK-created AgentSession, so
 * they never touch the local user's TUI session. See router.ts / qq-session.ts.
 *
 * Security: QQ turns a local coding agent into a remote control surface. The
 * runtime defaults to disabled with empty allowlists; empty allowlists mean no
 * inbound message is processed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, validateEnabled } from "./config";
import { PiQQBotRuntime } from "./router";
import { TerminalConversationView } from "./terminal-view";
import type { PiQQBotConfig } from "./types";

let runtime: PiQQBotRuntime | undefined;
let currentConfig: PiQQBotConfig | undefined;
let terminalView: TerminalConversationView | undefined;
let startPromise: Promise<boolean> | undefined;
let runtimeGeneration = 0;
let debugCommandRegistered = false;

export default function (pi: ExtensionAPI) {
	const attachTerminalView = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") return false;
		if (!terminalView) terminalView = new TerminalConversationView(ctx);
		runtime?.attachObserver(terminalView);
		return true;
	};

	const disposeTerminalView = (): void => {
		if (!terminalView) return;
		runtime?.detachObserver(terminalView);
		terminalView.dispose();
		terminalView = undefined;
	};

	// Create + connect the runtime on demand (shared by /qqbot-start and autoStart).
	const connect = async (ctx: ExtensionContext): Promise<boolean> => {
		if (runtime?.isReady()) return true;
		if (startPromise) return startPromise;
		if (!currentConfig) return false;
		const rt = new PiQQBotRuntime(currentConfig);
		const generation = ++runtimeGeneration;
		runtime = rt;
		if (terminalView) rt.attachObserver(terminalView);
		const pendingStart = (async (): Promise<boolean> => {
			const started = await rt.start(ctx);
			if (generation !== runtimeGeneration || runtime !== rt) {
				await rt.stop();
				return false;
			}
			if (!started) {
				await rt.stop();
				runtime = undefined;
			}
			return started;
		})();
		startPromise = pendingStart;
		try {
			return await pendingStart;
		} finally {
			if (startPromise === pendingStart) startPromise = undefined;
		}
	};

	pi.registerCommand("qqbot-start", {
		description: "Connect QQBot and show its conversation in this Pi terminal",
		handler: async (_args, ctx) => {
			if (!currentConfig || !currentConfig.enabled) {
				ctx.ui.notify("pi-qqbot: not enabled (set \"enabled\": true in ~/.pi/agent/pi-qqbot.json)", "warning");
				return;
			}
			const invalid = validateEnabled(currentConfig);
			if (invalid) {
				ctx.ui.notify(`pi-qqbot: cannot start (${invalid})`, "warning");
				return;
			}

			const viewAttached = attachTerminalView(ctx);
			const alreadyRunning = runtime?.isReady() === true;
			const started = alreadyRunning || (await connect(ctx));
			if (!started) {
				disposeTerminalView();
				ctx.ui.notify("pi-qqbot failed to start; use /qqbot-status for details", "error");
				return;
			}
			// The runtime may have been created by autoStart; attach after connect as well.
			if (terminalView) runtime?.attachObserver(terminalView);
			const viewText = viewAttached
				? "conversation view: attached to this Pi terminal"
				: `conversation view: unavailable in ${ctx.mode} mode (TUI only)`;
			ctx.ui.notify(
				`${alreadyRunning ? "pi-qqbot already running" : "pi-qqbot started"}\n${viewText}\n${runtime?.statusText() ?? ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("qqbot-stop", {
		description: "Disconnect QQBot and remove this terminal's conversation view",
		handler: async (_args, ctx) => {
			if (!runtime) {
				disposeTerminalView();
				ctx.ui.notify("pi-qqbot is not running", "info");
				return;
			}
			disposeTerminalView();
			const rt = runtime;
			runtime = undefined;
			runtimeGeneration++;
			await rt.stop();
			ctx.ui.notify("pi-qqbot stopped", "info");
		},
	});

	pi.registerCommand("qqbot-status", {
		description: "Show Pi QQBot connection status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime?.statusText() ?? "pi-qqbot is not running", "info");
		},
	});

	pi.registerCommand("qqbot-reconnect", {
		description: "Reconnect the Pi QQBot gateway",
		handler: async (_args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("pi-qqbot is not running", "info");
				return;
			}
			await runtime.reconnect();
			ctx.ui.notify(runtime.statusText(), "info");
		},
	});

	pi.registerCommand("qqbot-last", {
		description: "Show last QQBot inbound/outbound summary",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime?.lastSummary() ?? "no QQBot events yet", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const { config, missing, parseError } = await loadConfig();
		currentConfig = config;

		if (parseError) {
			if (ctx.hasUI) ctx.ui.notify(`pi-qqbot: invalid config (${parseError})`, "warning");
			return;
		}
		if (!config.enabled) {
			if (missing && ctx.hasUI) {
				ctx.ui.notify("pi-qqbot: no config found (~/.pi/agent/pi-qqbot.json); disabled", "info");
			}
			return;
		}

		const invalid = validateEnabled(config);
		if (invalid) {
			if (ctx.hasUI) ctx.ui.notify(`pi-qqbot: cannot start (${invalid})`, "warning");
			return;
		}

		// Debug-only local test command, gated behind config.debug.
		if (config.debug && !debugCommandRegistered) {
			debugCommandRegistered = true;
			pi.registerCommand("qqbot-fake", {
				description: "[debug] Simulate an inbound QQ private message",
				handler: async (args, cctx) => {
					if (!args.trim()) {
						cctx.ui.notify("Usage: /qqbot-fake <message>", "warning");
						return;
					}
					if (!runtime) {
						cctx.ui.notify("pi-qqbot is not running (use /qqbot-start)", "warning");
						return;
					}
					runtime.simulateInbound(args.trim());
				},
			});
		}

		// Do NOT connect automatically unless autoStart is set. Otherwise the user
		// opens the gateway on demand with /qqbot-start (avoids startup reconnect
		// spam when the network cannot reach QQ).
		if (config.autoStart) {
			const started = await connect(ctx);
			if (!started && ctx.hasUI) ctx.ui.notify("pi-qqbot: autoStart failed", "error");
		} else if (ctx.hasUI) {
			ctx.ui.notify("pi-qqbot: ready (not connected). Use /qqbot-start to connect and show QQ conversations here.", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		disposeTerminalView();
		const rt = runtime;
		runtime = undefined;
		runtimeGeneration++;
		startPromise = undefined;
		await rt?.stop();
	});
}
