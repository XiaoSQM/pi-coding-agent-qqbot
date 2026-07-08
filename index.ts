/**
 * pi-qqbot: connect the official QQ Bot API to Pi (text-only MVP).
 *
 * Lifecycle:
 *  - Commands are registered immediately (in the factory).
 *  - The QQ runtime (sockets/timers) starts in session_start and is torn down
 *    in session_shutdown, per the Pi extension guidelines.
 *
 * Security: QQ turns a local coding agent into a remote control surface. The
 * runtime defaults to disabled with empty allowlists; empty allowlists mean no
 * inbound message is processed. QQ messages are injected into the SAME Pi
 * session the local user drives — see README.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, validateEnabled } from "./config";
import { PiQQBotRuntime } from "./router";

let runtime: PiQQBotRuntime | undefined;
let debugCommandRegistered = false;

export default function (pi: ExtensionAPI) {
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
						cctx.ui.notify("pi-qqbot is not running", "warning");
						return;
					}
					runtime.simulateInbound(args.trim());
				},
			});
		}

		runtime = new PiQQBotRuntime(pi, config);
		await runtime.start(ctx);
	});

	pi.on("agent_start", async () => {
		runtime?.handleAgentStart();
	});

	pi.on("tool_execution_start", async (event) => {
		runtime?.recordToolStart(event.toolName, event.args);
	});

	pi.on("tool_execution_end", async (event) => {
		runtime?.recordToolEnd(event.toolName, event.isError);
	});

	pi.on("agent_end", async (event, ctx) => {
		await runtime?.handleAgentEnd(event as { messages?: unknown[] }, ctx);
	});

	pi.on("session_shutdown", async () => {
		await runtime?.stop();
		runtime = undefined;
	});
}
