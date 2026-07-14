/** Config loading and strict normalization for pi-qqbot. */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PiQQBotConfig, QQMediaConfig, QQMediaSttConfig } from "./types";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-qqbot.json");

const MEDIA_DEFAULTS: QQMediaConfig = {
	enabled: true,
	maxAttachments: 4,
	maxTotalBytes: 30 * 1024 * 1024,
	downloadTimeoutMs: 120_000,
	image: { enabled: true, maxBytes: 10 * 1024 * 1024 },
	voice: { enabled: true, preferQQAsr: true, maxBytes: 25 * 1024 * 1024 },
	documents: {
		enabled: true,
		allowExtensions: [".txt", ".pdf", ".doc"],
		maxTxtBytes: 2 * 1024 * 1024,
		maxPdfBytes: 20 * 1024 * 1024,
		maxDocBytes: 10 * 1024 * 1024,
		maxPdfPages: 100,
		maxExtractedChars: 150_000,
	},
};

const DEFAULTS: PiQQBotConfig = {
	enabled: false,
	autoStart: false,
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
	replyFormat: "auto",
	media: MEDIA_DEFAULTS,
	debug: false,
};

export interface LoadConfigResult {
	config: PiQQBotConfig;
	missing?: boolean;
	parseError?: string;
}

export async function loadConfig(): Promise<LoadConfigResult> {
	let text: string;
	try {
		text = await readFile(CONFIG_PATH, "utf-8");
	} catch {
		return { config: cloneDefaults(), missing: true };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {
			config: cloneDefaults(),
			parseError: err instanceof Error ? err.message : String(err),
		};
	}

	return { config: normalizeConfig(parsed) };
}

export function normalizeConfig(parsed: unknown): PiQQBotConfig {
	const raw = isRecord(parsed) ? parsed : {};
	const rawMedia = isRecord(raw.media) ? raw.media : {};
	const rawImage = isRecord(rawMedia.image) ? rawMedia.image : {};
	const rawVoice = isRecord(rawMedia.voice) ? rawMedia.voice : {};
	const rawDocuments = isRecord(rawMedia.documents) ? rawMedia.documents : {};
	const rawStt = isRecord(rawVoice.stt) ? rawVoice.stt : undefined;

	const config: PiQQBotConfig = {
		...DEFAULTS,
		...raw,
		enabled: bool(raw.enabled, DEFAULTS.enabled),
		autoStart: bool(raw.autoStart, DEFAULTS.autoStart ?? false),
		appId: stringValue(raw.appId, ""),
		clientSecret: stringValue(raw.clientSecret, ""),
		sandbox: bool(raw.sandbox, true),
		allowUsers: stringArray(raw.allowUsers),
		allowGroups: stringArray(raw.allowGroups),
		replyPrefix: stringValue(raw.replyPrefix, ""),
		maxQueueSize: integer(raw.maxQueueSize, 20, 1, 1000),
		sendBusyNotice: bool(raw.sendBusyNotice, false),
		allowCommands: bool(raw.allowCommands, false),
		showProcess: bool(raw.showProcess, false),
		replyFormat: raw.replyFormat === "plain" ? "plain" : "auto",
		debug: bool(raw.debug, false),
		media: {
			enabled: bool(rawMedia.enabled, MEDIA_DEFAULTS.enabled),
			maxAttachments: integer(rawMedia.maxAttachments, 4, 1, 10),
			maxTotalBytes: integer(rawMedia.maxTotalBytes, MEDIA_DEFAULTS.maxTotalBytes, 1, 100 * 1024 * 1024),
			downloadTimeoutMs: integer(rawMedia.downloadTimeoutMs, 120_000, 1000, 300_000),
			image: {
				enabled: bool(rawImage.enabled, true),
				maxBytes: integer(rawImage.maxBytes, 10 * 1024 * 1024, 1, 25 * 1024 * 1024),
			},
			voice: {
				enabled: bool(rawVoice.enabled, true),
				preferQQAsr: bool(rawVoice.preferQQAsr, true),
				maxBytes: integer(rawVoice.maxBytes, 25 * 1024 * 1024, 1, 50 * 1024 * 1024),
				...(rawStt ? { stt: normalizeStt(rawStt) } : {}),
			},
			documents: {
				enabled: bool(rawDocuments.enabled, true),
				allowExtensions: normalizeExtensions(rawDocuments.allowExtensions),
				maxTxtBytes: integer(rawDocuments.maxTxtBytes, 2 * 1024 * 1024, 1, 10 * 1024 * 1024),
				maxPdfBytes: integer(rawDocuments.maxPdfBytes, 20 * 1024 * 1024, 1, 50 * 1024 * 1024),
				maxDocBytes: integer(rawDocuments.maxDocBytes, 10 * 1024 * 1024, 1, 25 * 1024 * 1024),
				maxPdfPages: integer(rawDocuments.maxPdfPages, 100, 1, 500),
				maxExtractedChars: integer(rawDocuments.maxExtractedChars, 150_000, 1000, 300_000),
			},
		},
	};
	return config;
}

function normalizeStt(raw: Record<string, unknown>): QQMediaSttConfig {
	return {
		baseUrl: stringValue(raw.baseUrl, "").replace(/\/+$/, ""),
		apiKeyEnv: stringValue(raw.apiKeyEnv, "QQBOT_STT_API_KEY"),
		model: stringValue(raw.model, "whisper-1"),
		timeoutMs: integer(raw.timeoutMs, 60_000, 1000, 120_000),
	};
}

function normalizeExtensions(value: unknown): string[] {
	const values = Array.isArray(value) ? value : MEDIA_DEFAULTS.documents.allowExtensions;
	const allowed = new Set([".txt", ".pdf", ".doc"]);
	const normalized = values
		.filter((v): v is string => typeof v === "string")
		.map((v) => (v.startsWith(".") ? v : `.${v}`).toLowerCase())
		.filter((v) => allowed.has(v));
	return normalized.length ? [...new Set(normalized)] : [...MEDIA_DEFAULTS.documents.allowExtensions];
}

function cloneDefaults(): PiQQBotConfig {
	return normalizeConfig(DEFAULTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/** Returns an error string if an enabled config is missing required fields. */
export function validateEnabled(config: PiQQBotConfig): string | undefined {
	if (!config.appId) return "missing appId";
	if (!config.clientSecret) return "missing clientSecret";
	const stt = config.media.voice.stt;
	if (stt && (!stt.baseUrl || !stt.model || !stt.apiKeyEnv)) return "invalid media.voice.stt configuration";
	return undefined;
}

/** Mask an appId for safe display, e.g. 123456**** */
export function maskAppId(appId: string): string {
	if (!appId) return "(none)";
	if (appId.length <= 6) return `${appId[0] ?? ""}****`;
	return `${appId.slice(0, 6)}****`;
}
