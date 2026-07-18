import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PiQQBotRuntime } from "./router";
import type { PiQQBotConfig, QQConversationObserver } from "./types";

const HOST_SYMBOL = Symbol.for("pi-coding-agent-qqbot.host.v1");

// Bump this whenever the in-memory runtime contract changes. A reload must not
// retain a Gateway host created by older router or transport code.
export const QQBOT_HOST_SCHEMA = 2;
export const QQBOT_BUILD_ID = createBuildId();

interface GlobalWithQQHost {
	[HOST_SYMBOL]?: QQBotHost;
}

export interface QQBotHostDiagnostics {
	buildId: string;
	schema: number;
	createdAt: number;
	runtimeStartedAt?: number;
	ownerCount: number;
	runtimeReady: boolean;
	restoreRuntime: boolean;
	replacedHost?: string;
}

export class QQBotHost {
	readonly schema = QQBOT_HOST_SCHEMA;
	readonly buildId = QQBOT_BUILD_ID;
	readonly createdAt = Date.now();
	private config: PiQQBotConfig;
	private configFingerprint: string;
	private runtime?: PiQQBotRuntime;
	private runtimeStartedAt?: number;
	private startPromise?: Promise<boolean>;
	private stopPromise?: Promise<void>;
	private stopTimer?: ReturnType<typeof setTimeout>;
	private readonly owners = new Set<symbol>();

	constructor(
		config: PiQQBotConfig,
		private readonly restoreRuntime: boolean,
		private readonly replacedHost?: string,
	) {
		this.config = config;
		this.configFingerprint = fingerprint(config);
	}

	getRuntime(): PiQQBotRuntime | undefined {
		return this.runtime;
	}

	getDiagnostics(): QQBotHostDiagnostics {
		return {
			buildId: this.buildId,
			schema: this.schema,
			createdAt: this.createdAt,
			runtimeStartedAt: this.runtimeStartedAt,
			ownerCount: this.owners.size,
			runtimeReady: this.runtime?.isReady() === true,
			restoreRuntime: this.restoreRuntime,
			...(this.replacedHost ? { replacedHost: this.replacedHost } : {}),
		};
	}

	applyRuntimeConfig(config: PiQQBotConfig): void {
		this.config = config;
		this.configFingerprint = fingerprint(config);
		this.runtime?.applyRuntimeConfig(config);
	}

	// Kept for the approval/revoke command call sites.
	applyAccessConfig(config: PiQQBotConfig): void {
		this.applyRuntimeConfig(config);
	}

	get ownerCount(): number {
		return this.owners.size;
	}

	shouldRestoreRuntime(): boolean {
		return this.restoreRuntime && !this.runtime?.isReady();
	}

	matchesConfig(config: PiQQBotConfig): boolean {
		return this.configFingerprint === fingerprint(config);
	}

	attach(owner: symbol, config: PiQQBotConfig, observer?: QQConversationObserver, ctx?: ExtensionContext): void {
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
		this.owners.add(owner);
		// Config changes that do not alter the runtime fingerprint (for example
		// page size, allowlists, and command UI settings) take effect immediately.
		this.applyRuntimeConfig(config);
		if (ctx) this.runtime?.bindUiContext(ctx);
		if (observer) this.runtime?.attachObserver(observer);
	}

	detach(owner: symbol, observer?: QQConversationObserver): void {
		if (observer) this.runtime?.detachObserver(observer);
		this.owners.delete(owner);
		// Drop the local TUI ctx as soon as no extension owns the host so gateway
		// callbacks during session handoff cannot touch a stale ExtensionContext.
		if (this.owners.size === 0) this.runtime?.bindUiContext(undefined);
	}

	async start(ctx: ExtensionContext, observer?: QQConversationObserver): Promise<boolean> {
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
		await this.stopPromise;
		if (this.runtime?.isReady()) {
			this.runtime.bindUiContext(ctx);
			if (observer) this.runtime.attachObserver(observer);
			return true;
		}
		if (this.startPromise) return this.startPromise;
		const runtime = new PiQQBotRuntime(this.config);
		this.runtime = runtime;
		if (observer) runtime.attachObserver(observer);
		const pending = (async () => {
			const started = await runtime.start(ctx);
			if (started && this.runtime === runtime) this.runtimeStartedAt = Date.now();
			if (!started && this.runtime === runtime) {
				await runtime.stop();
				this.runtime = undefined;
			}
			return started;
		})();
		this.startPromise = pending;
		try {
			return await pending;
		} finally {
			if (this.startPromise === pending) this.startPromise = undefined;
		}
	}

	/**
	 * Local session replacement gets a grace period so the new extension
	 * instance can attach without tearing down the QQ gateway.
	 */
	scheduleStop(graceMs: number): void {
		if (this.owners.size > 0 || this.stopTimer) return;
		this.stopTimer = setTimeout(() => {
			this.stopTimer = undefined;
			if (this.owners.size === 0) void this.stop();
		}, graceMs);
		this.stopTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = undefined;
		const runtime = this.runtime;
		this.runtime = undefined;
		this.runtimeStartedAt = undefined;
		this.startPromise = undefined;
		const pending = runtime?.stop() ?? Promise.resolve();
		this.stopPromise = pending;
		try {
			await pending;
		} finally {
			if (this.stopPromise === pending) this.stopPromise = undefined;
		}
	}
}

export async function acquireQQBotHost(config: PiQQBotConfig): Promise<QQBotHost> {
	const globalObject = globalThis as GlobalWithQQHost;
	const existing = globalObject[HOST_SYMBOL];
	if (existing?.schema === QQBOT_HOST_SCHEMA && existing.buildId === QQBOT_BUILD_ID && existing.matchesConfig(config)) {
		return existing;
	}
	const restoreRuntime = existing?.getRuntime()?.isReady() === true;
	const replacedHost = existing
		? `schema=${String(existing.schema)}, build=${existing.buildId ?? "unknown"}`
		: undefined;
	if (existing) {
		const previousRuntime = existing.getRuntime() as (PiQQBotRuntime & {
			isIdle?: () => boolean;
			waitForIdle?: (timeoutMs: number) => Promise<boolean>;
		}) | undefined;
		// Give an in-flight QQ request a bounded drain window before replacement.
		// Older in-memory runtimes do not expose these helpers, so capability-test
		// before forcing the replacement.
		if (previousRuntime?.isIdle && previousRuntime.waitForIdle && !previousRuntime.isIdle()) {
			await previousRuntime.waitForIdle(5_000);
		}
		await existing.stop();
	}
	const host = new QQBotHost(config, restoreRuntime, replacedHost);
	globalObject[HOST_SYMBOL] = host;
	return host;
}

function createBuildId(): string {
	const directory = dirname(fileURLToPath(import.meta.url));
	const hash = createHash("sha256");
	const sourceFiles = readdirSync(directory)
		.filter((filename) => (filename.endsWith(".ts") && !filename.endsWith(".test.ts")) || filename === "package.json")
		.sort();
	for (const filename of sourceFiles) {
		hash.update(filename).update(readFileSync(join(directory, filename)));
	}
	return `0.4.0-${hash.digest("hex").slice(0, 12)}`;
}

function fingerprint(config: PiQQBotConfig): string {
	return JSON.stringify({
		appId: config.appId,
		clientSecret: config.clientSecret,
		sandbox: config.sandbox,
		sessions: config.sessions,
		media: config.media,
		outboundMedia: config.outboundMedia,
		maxQueueSize: config.maxQueueSize,
	});
}
