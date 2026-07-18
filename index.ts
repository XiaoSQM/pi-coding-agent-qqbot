/**
 * pi-qqbot extension entry.
 *
 * The QQ gateway is owned by a process-level host rather than a local Pi
 * session. `/new`, `/resume`, `/fork`, and `/reload` detach only the TUI
 * observer; a replacement extension instance reattaches during its
 * `session_start` event without reconnecting QQ.
 */

import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

import { loadConfig, removeAccessUser, updateAccessList, validateEnabled } from "./config";
import { acquireQQBotHost, type QQBotHost } from "./host-registry";
import { TerminalConversationView } from "./terminal-view";
import { normalizeAccessRole } from "./access-requests";
import type { PiQQBotConfig } from "./types";

const OWNER_TOKEN = Symbol("pi-qqbot-extension-owner");
let currentConfig: PiQQBotConfig | undefined;
let host: QQBotHost | undefined;
let terminalView: TerminalConversationView | undefined;
let ownerAttached = false;
let debugCommandRegistered = false;

export default function (pi: ExtensionAPI) {
	const runtime = () => host?.getRuntime();

	const attachOwner = async (config: PiQQBotConfig, ctx?: ExtensionContext): Promise<QQBotHost> => {
		const acquired = await acquireQQBotHost(config);
		if (host && host !== acquired && ownerAttached) host.detach(OWNER_TOKEN, terminalView);
		// Always re-attach so a replacement TUI can rebind its ExtensionContext
		// while the process-level QQ gateway stays connected.
		host = acquired;
		host.attach(OWNER_TOKEN, config, terminalView, ctx);
		ownerAttached = true;
		return acquired;
	};

	const attachTerminalView = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") return false;
		if (!terminalView) terminalView = new TerminalConversationView(ctx);
		runtime()?.attachObserver(terminalView);
		return true;
	};

	const disposeTerminalView = (): void => {
		if (!terminalView) return;
		runtime()?.detachObserver(terminalView);
		terminalView.dispose();
		terminalView = undefined;
	};

	const connect = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!currentConfig) return false;
		const currentHost = await attachOwner(currentConfig, ctx);
		return currentHost.start(ctx, terminalView);
	};

	pi.registerCommand("qqbot-start", {
		description: "Connect QQBot and attach its conversation view to this terminal",
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
			const alreadyRunning = runtime()?.isReady() === true;
			const started = alreadyRunning || (await connect(ctx));
			if (!started) {
				disposeTerminalView();
				ctx.ui.notify("pi-qqbot failed to start; use /qqbot-status for details", "error");
				return;
			}
			if (terminalView) runtime()?.attachObserver(terminalView);
			ctx.ui.notify(
				`${alreadyRunning ? "pi-qqbot already running" : "pi-qqbot started"}\n${viewAttached ? "conversation view: attached" : `conversation view: unavailable in ${ctx.mode} mode`}\n${runtime()?.statusText() ?? ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("qqbot-stop", {
		description: "Disconnect the process-level QQBot host",
		handler: async (_args, ctx) => {
			disposeTerminalView();
			if (!host?.getRuntime()) {
				ctx.ui.notify("pi-qqbot is not running", "info");
				return;
			}
			await host.stop();
			ctx.ui.notify("pi-qqbot stopped", "info");
		},
	});

	pi.registerCommand("qqbot-status", {
		description: "Show Pi QQBot connection status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`${runtime()?.statusText() ?? "pi-qqbot is not running"}\nhost owners: ${host?.ownerCount ?? 0}`, "info");
		},
	});

	pi.registerCommand("qqbot-runtime", {
		description: "Show QQBot runtime build and reload diagnostics",
		handler: async (_args, ctx) => {
			const diagnostics = host?.getDiagnostics();
			if (!diagnostics) {
				ctx.ui.notify("pi-qqbot runtime is not initialized", "info");
				return;
			}
			const lines = [
				`build: ${diagnostics.buildId}`,
				`host schema: ${diagnostics.schema}`,
				`host created: ${new Date(diagnostics.createdAt).toLocaleString()}`,
				`runtime: ${diagnostics.runtimeReady ? "ready" : "stopped"}`,
				`runtime started: ${diagnostics.runtimeStartedAt ? new Date(diagnostics.runtimeStartedAt).toLocaleString() : "n/a"}`,
				`owners: ${diagnostics.ownerCount}`,
				`restore after reload: ${diagnostics.restoreRuntime ? "yes" : "no"}`,
				`model page size: ${currentConfig?.commands.modelPageSize ?? "n/a"}`,
				...(diagnostics.replacedHost ? [`replaced host: ${diagnostics.replacedHost}`] : []),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qqbot-reconnect", {
		description: "Reconnect the Pi QQBot gateway",
		handler: async (_args, ctx) => {
			if (!runtime()) {
				ctx.ui.notify("pi-qqbot is not running", "info");
				return;
			}
			await runtime()?.reconnect();
			ctx.ui.notify(runtime()?.statusText() ?? "pi-qqbot is not running", "info");
		},
	});

	pi.registerCommand("qqbot-last", {
		description: "Show last QQBot inbound/outbound summary",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime()?.lastSummary() ?? "no QQBot events yet", "info");
		},
	});

	pi.registerCommand("qqbot-requests", {
		description: "Review pending QQ access requests",
		handler: async (_args, ctx) => {
			const rt = runtime();
			if (!rt) {
				ctx.ui.notify("pi-qqbot is not running", "warning");
				return;
			}
			const requests = rt.listAccessRequests();
			if (!requests.length) {
				ctx.ui.notify("没有待处理的 QQ 访问申请", "info");
				return;
			}
			const labels = requests.map((request) =>
				`${request.code}  ${maskOpenId(request.userOpenId)}  ${new Date(request.createdAt).toLocaleTimeString()}`,
			);
			const choice = await ctx.ui.select("选择 QQ 访问申请", labels);
			if (!choice) return;
			const request = requests[labels.indexOf(choice)];
			if (!request) return;
			const action = await ctx.ui.select("选择权限", ["普通用户", "管理员", "拒绝", "取消"]);
			if (!action || action === "取消") return;
			if (action === "拒绝") {
				const denied = rt.denyAccessRequest(request.code);
				if (!denied) {
					ctx.ui.notify("申请已过期或已处理", "warning");
					return;
				}
				await rt.notifyAccessDecision(denied, "denied");
				ctx.ui.notify(`已拒绝申请 ${request.code}`, "info");
				return;
			}
			const role = action === "管理员" ? "admin" : "user";
			if (role === "admin") {
				const confirmed = await ctx.ui.confirm(
					"授予 QQ 管理员权限？",
					`用户 ${request.userOpenId}\n将能够切换模型、新建/恢复/压缩/停止 QQ 会话。`,
				);
				if (!confirmed) return;
			}
			await approveRequest(request.code, role, ctx);
		},
	});

	pi.registerCommand("qqbot-approve", {
		description: "Approve a QQ access request: /qqbot-approve <code> <user|admin>",
		handler: async (args, ctx) => {
			const [code, roleText] = args.trim().split(/\s+/);
			const role = normalizeAccessRole(roleText);
			if (!code || !role) {
				ctx.ui.notify("用法：/qqbot-approve <申请码> <user|admin>", "warning");
				return;
			}
			const request = runtime()?.listAccessRequests().find((item) => item.code === code.toUpperCase());
			if (!request) {
				ctx.ui.notify("申请不存在、已过期或已处理", "warning");
				return;
			}
			if (role === "admin") {
				const confirmed = await ctx.ui.confirm(
					"授予 QQ 管理员权限？",
					`用户 ${request.userOpenId}\n将能够切换模型、新建/恢复/压缩/停止 QQ 会话。`,
				);
				if (!confirmed) return;
			}
			await approveRequest(request.code, role, ctx);
		},
	});

	pi.registerCommand("qqbot-deny", {
		description: "Deny a pending QQ access request",
		handler: async (args, ctx) => {
			const code = args.trim().toUpperCase();
			if (!code) {
				ctx.ui.notify("用法：/qqbot-deny <申请码>", "warning");
				return;
			}
			const request = runtime()?.denyAccessRequest(code);
			if (!request) {
				ctx.ui.notify("申请不存在、已过期或已处理", "warning");
				return;
			}
			await runtime()?.notifyAccessDecision(request, "denied");
			ctx.ui.notify(`已拒绝申请 ${code}`, "info");
		},
	});

	pi.registerCommand("qqbot-revoke", {
		description: "Remove a QQ user from both ordinary and admin allowlists",
		handler: async (args, ctx) => {
			const openid = args.trim();
			if (!openid) {
				ctx.ui.notify("用法：/qqbot-revoke <user_openid>", "warning");
				return;
			}
			const confirmed = await ctx.ui.confirm("移除 QQ 权限？", `用户 ${openid}\n将同时移出普通用户和管理员白名单。`);
			if (!confirmed) return;
			const config = await removeAccessUser(openid);
			currentConfig = config;
			host?.applyAccessConfig(config);
			ctx.ui.notify(`已移除 QQ 用户权限：${maskOpenId(openid)}`, "info");
		},
	});

	const approveRequest = async (
		code: string,
		role: "user" | "admin",
		ctx: ExtensionContext,
	): Promise<void> => {
		const rt = runtime();
		const pending = rt?.listAccessRequests().find((request) => request.code === code);
		if (!rt || !pending) {
			ctx.ui.notify("申请不存在、已过期或已处理", "warning");
			return;
		}
		// Persist first. If writing fails, the request remains pending and the
		// running allowlist is unchanged.
		const config = await updateAccessList(pending.userOpenId, role);
		const request = rt.approveAccessRequest(code);
		if (!request) {
			ctx.ui.notify("配置已写入，但申请状态已经变化；请检查 /qqbot-status", "warning");
			return;
		}
		currentConfig = config;
		host?.applyAccessConfig(config);
		await rt.notifyAccessDecision(request, role);
		ctx.ui.notify(
			`已批准 ${maskOpenId(request.userOpenId)}：${role === "admin" ? "管理员" : "普通用户"}\n配置已保存，无需 /reload。`,
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		const { config, missing, parseError } = await loadConfig();
		currentConfig = config;
		if (parseError) {
			if (ctx.hasUI) ctx.ui.notify(`pi-qqbot: invalid config (${parseError})`, "warning");
			return;
		}
		if (!config.enabled) {
			if (missing && ctx.hasUI) ctx.ui.notify("pi-qqbot: no config found (~/.pi/agent/pi-qqbot.json); disabled", "info");
			return;
		}
		const invalid = validateEnabled(config);
		if (invalid) {
			if (ctx.hasUI) ctx.ui.notify(`pi-qqbot: cannot start (${invalid})`, "warning");
			return;
		}

		await attachOwner(config, ctx);
		// A replacement TUI automatically regains the observer. Users no longer
		// need to run /qqbot-start after local /new, /resume, /fork, or /reload.
		attachTerminalView(ctx);

		if (config.debug && !debugCommandRegistered) {
			debugCommandRegistered = true;
			pi.registerCommand("qqbot-fake", {
				description: "[debug] Simulate an inbound QQ private message",
				handler: async (args, cctx) => {
					if (!args.trim()) {
						cctx.ui.notify("Usage: /qqbot-fake <message>", "warning");
						return;
					}
					if (!runtime()) {
						cctx.ui.notify("pi-qqbot is not running", "warning");
						return;
					}
					runtime()?.simulateInbound(args.trim());
				},
			});
		}

		const restoreRuntime = host?.shouldRestoreRuntime() === true;
		if (config.startup.mode === "auto" || restoreRuntime) {
			const started = await connect(ctx);
			if (!started && ctx.hasUI) ctx.ui.notify("pi-qqbot: automatic startup failed", "error");
			if (started && restoreRuntime && ctx.hasUI) ctx.ui.notify("pi-qqbot: runtime replaced and QQ gateway restored", "info");
		} else if (config.startup.mode === "manual" && !runtime()?.isReady() && ctx.hasUI) {
			ctx.ui.notify("pi-qqbot: ready (manual mode). Use /qqbot-start to connect.", "info");
		}
	});

	pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
		disposeTerminalView();
		if (!host || !ownerAttached) return;
		host.detach(OWNER_TOKEN);
		ownerAttached = false;
		if (!currentConfig?.startup.keepAcrossLocalSessions) {
			await host.stop();
			return;
		}
		// A TUI "quit" can be part of the same-process replacement/reload path
		// on supported Pi versions. Give every shutdown reason the same bounded
		// handoff window; if no replacement attaches, the host fully stops.
		host.scheduleStop(currentConfig.startup.handoffGraceMs);
	});
}

function maskOpenId(value: string): string {
	if (value.length <= 12) return `${value.slice(0, 3)}…${value.slice(-3)}`;
	return `${value.slice(0, 6)}…${value.slice(-6)}`;
}
