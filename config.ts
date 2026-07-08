/**
 * Config loading for pi-qqbot.
 *
 * Reads ~/.pi/agent/pi-qqbot.json. Missing/invalid config must not crash the
 * extension: loadConfig() always returns a config object, using a disabled
 * default when the file is absent or unparseable. Validation of required fields
 * happens only when enabled === true (see validateEnabled()).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PiQQBotConfig } from "./types";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-qqbot.json");

const DEFAULTS: PiQQBotConfig = {
	enabled: false,
	appId: "",
	clientSecret: "",
	sandbox: true,
	allowUsers: [],
	allowGroups: [],
	replyPrefix: "",
	maxQueueSize: 20,
	sendBusyNotice: false,
	allowCommands: false,
	showProcess: false,
	debug: false,
};

export interface LoadConfigResult {
	config: PiQQBotConfig;
	/** Set when the config file was missing. */
	missing?: boolean;
	/** Set when the file existed but could not be parsed. */
	parseError?: string;
}

export async function loadConfig(): Promise<LoadConfigResult> {
	let text: string;
	try {
		text = await readFile(CONFIG_PATH, "utf-8");
	} catch {
		return { config: { ...DEFAULTS }, missing: true };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {
			config: { ...DEFAULTS },
			parseError: err instanceof Error ? err.message : String(err),
		};
	}

	const raw = (parsed ?? {}) as Partial<PiQQBotConfig>;
	const config: PiQQBotConfig = {
		...DEFAULTS,
		...raw,
		// normalize arrays so callers can rely on them existing
		allowUsers: Array.isArray(raw.allowUsers) ? raw.allowUsers : [],
		allowGroups: Array.isArray(raw.allowGroups) ? raw.allowGroups : [],
	};
	return { config };
}

/**
 * Returns an error string if an enabled config is missing required fields, or
 * undefined if it is usable. Empty allowlists are a valid (safe) state but mean
 * no inbound message will be processed.
 */
export function validateEnabled(config: PiQQBotConfig): string | undefined {
	if (!config.appId) return "missing appId";
	if (!config.clientSecret) return "missing clientSecret";
	return undefined;
}

/** Mask an appId for safe display, e.g. 123456**** */
export function maskAppId(appId: string): string {
	if (!appId) return "(none)";
	if (appId.length <= 6) return `${appId[0] ?? ""}****`;
	return `${appId.slice(0, 6)}****`;
}
