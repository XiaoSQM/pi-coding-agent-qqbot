/** Shared types for the pi-qqbot extension. */

/** Pi SDK-compatible inline image payload. */
export interface QQImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface QQMediaSttConfig {
	baseUrl: string;
	/** Name of the environment variable containing the API key. */
	apiKeyEnv: string;
	model: string;
	timeoutMs: number;
}

export interface QQOutboundMediaConfig {
	enabled: boolean;
	adminsOnly: boolean;
	allowPrivate: boolean;
	allowGroups: boolean;
	allowedRoots: string[];
	images: boolean;
	files: boolean;
	maxFilesPerTurn: number;
	maxImageBytes: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	uploadTimeoutMs: number;
}

export interface QQMediaConfig {
	enabled: boolean;
	maxAttachments: number;
	maxTotalBytes: number;
	downloadTimeoutMs: number;
	image: {
		enabled: boolean;
		maxBytes: number;
	};
	voice: {
		enabled: boolean;
		preferQQAsr: boolean;
		maxBytes: number;
		stt?: QQMediaSttConfig;
	};
	documents: {
		enabled: boolean;
		allowExtensions: string[];
		maxTxtBytes: number;
		maxPdfBytes: number;
		maxDocBytes: number;
		maxPdfPages: number;
		maxExtractedChars: number;
	};
}

export type QQReplyFormat = "auto" | "plain";

/** Optional slow-task progress feedback sent as a passive QQ reply. */
export interface QQProgressConfig {
	/** Send one "processing" ack if the agent task is still running after ackAfterMs. */
	enabled: boolean;
	/** Delay before the slow-task ack. 0 sends as soon as the run starts. */
	ackAfterMs: number;
}

export interface QQCommandConfig {
	enabled: boolean;
	accessRequests: boolean;
	allowInGroups: boolean;
	/** QQ user/member openids allowed to mutate model and session state. */
	admins: string[];
	buttons: boolean;
	maxListItems: number;
	modelPageSize: number;
	selectionTtlMs: number;
	confirmationTtlMs: number;
}

export interface QQSessionConfig {
	mode: "persistent" | "memory";
	scope: "conversation";
	restore: "recent" | "new";
	maxResident: number;
	idleDisposeMs: number;
}

export interface QQStartupConfig {
	mode: "auto" | "manual" | "service";
	keepAcrossLocalSessions: boolean;
	handoffGraceMs: number;
}

export interface PiQQBotConfig {
	/** Persisted config schema. Legacy files are normalized to the current version. */
	schemaVersion: 3;
	enabled: boolean;
	/** @deprecated Use startup.mode. Kept for one-version config compatibility. */
	autoStart?: boolean;
	appId: string;
	clientSecret: string;
	sandbox?: boolean;
	allowUsers?: string[];
	allowGroups?: string[];
	replyPrefix?: string;
	maxQueueSize?: number;
	sendBusyNotice?: boolean;
	/** @deprecated Use commands.enabled. Unknown slash input is never forwarded as a prompt. */
	allowCommands?: boolean;
	commands: QQCommandConfig;
	sessions: QQSessionConfig;
	startup: QQStartupConfig;
	/** Include a compact execution summary after the final answer. */
	showProcess?: boolean;
	/** Prefer native QQ Markdown with a safe plain-text fallback, or force plain text. */
	replyFormat: QQReplyFormat;
	/** Slow-task progress ack inside the passive-reply budget. */
	progress: QQProgressConfig;
	/** Local computer -> current QQ conversation rich-media delivery policy. */
	outboundMedia: QQOutboundMediaConfig;
	media: QQMediaConfig;
	debug?: boolean;
}

export interface QQAttachment {
	contentType: string;
	filename: string;
	size?: number;
	width?: number;
	height?: number;
	url?: string;
	voiceWavUrl?: string;
	asrReferText?: string;
}

/** A normalized inbound QQ message. */
export interface QQInboundMessage {
	id: string; // platform message id, required for passive reply
	type: "private" | "group";
	text: string;
	userOpenId: string; // user_openid (private) or member_openid (group)
	groupOpenId?: string;
	attachments: QQAttachment[];
	raw: unknown;
	receivedAt: number;
	/** Internal: locally simulated message (/qqbot-fake). Reply is not sent to QQ. */
	fake?: boolean;
}

export type AttachmentStatus = "ready" | "rejected" | "failed";

export type PreparedAttachment =
	| {
			kind: "image";
			filename: string;
			status: AttachmentStatus;
			mimeType?: string;
			note?: string;
			errorCode?: string;
	  }
	| {
			kind: "voice";
			filename: string;
			status: AttachmentStatus;
			transcript?: string;
			source?: "qq-asr" | "stt";
			note?: string;
			errorCode?: string;
	  }
	| {
			kind: "document";
			filename: string;
			status: AttachmentStatus;
			extractedText?: string;
			truncated?: boolean;
			note?: string;
			errorCode?: string;
	  }
	| {
			kind: "unsupported";
			filename: string;
			status: "rejected";
			reason: string;
			errorCode: string;
	  };

export interface PreparedQQMessage {
	prompt: string;
	images: QQImageContent[];
	resources: PreparedAttachment[];
	cleanup(): Promise<void>;
}

/**
 * Reply target. QQ replies must be sent as passive messages that reference the
 * originating msg_id (and msg_seq), inside a time window (C2C 60min, group 5min).
 */
export interface QQReplyTarget {
	type: "private" | "group";
	userOpenId: string;
	groupOpenId?: string;
	msgId: string; // original inbound message id
	createdAt: number; // to reason about the passive-reply window
}

export interface QQKeyboardButton {
	id: string;
	render_data: {
		label: string;
		visited_label: string;
		style: 0 | 1;
	};
	action: {
		type: 2;
		permission: { type: 2 };
		data: string;
		reply: boolean;
		enter: boolean;
		unsupport_tips: string;
	};
}

export interface QQKeyboard {
	content: {
		rows: Array<{ buttons: QQKeyboardButton[] }>;
	};
}

export type ConnectionState =
	| "disabled"
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

export type QQAttachmentEventKind = "attachment_start" | "attachment_progress" | "attachment_end" | "attachment_rejected";
export type QQOutboundEventKind = "outbound_start" | "outbound_uploaded" | "outbound_sent" | "outbound_failed";

export interface QQMediaUploadResult {
	fileInfo: string;
	fileUuid?: string;
	ttl: number;
}

export interface QQOutboundDeliveryRecord {
	filename: string;
	kind: "image" | "file";
	bytes: number;
	status: "sent" | "failed" | "unknown";
	errorCode?: string;
	note?: string;
}

/** Process-local events mirrored only into the Pi terminal that ran /qqbot-start. */
export type QQTerminalEvent =
	| {
			kind: "runtime_state";
			connection: ConnectionState;
			detail?: string;
			queueSize: number;
			running: boolean;
			activeLabel?: string;
			at: number;
	  }
	| {
			kind: "inbound";
			messageId: string;
			channel: "private" | "group";
			senderLabel: string;
			text: string;
			attachmentCount: number;
			attachmentKinds: string[];
			fake: boolean;
			at: number;
	  }
	| { kind: "queued"; messageId: string; queueSize: number; at: number }
	| {
			kind: QQAttachmentEventKind;
			messageId: string;
			index: number;
			total: number;
			attachmentKind: string;
			filename: string;
			bytes?: number;
			status?: AttachmentStatus;
			note?: string;
			at: number;
	  }
	| {
			kind: QQOutboundEventKind;
			messageId: string;
			mediaKind: "image" | "file";
			filename: string;
			bytes: number;
			errorCode?: string;
			note?: string;
			at: number;
	  }
	| { kind: "run_start"; messageId: string; at: number }
	| { kind: "assistant_start"; messageId: string; at: number }
	| { kind: "assistant_delta"; messageId: string; delta: string; at: number }
	| { kind: "assistant_end"; messageId: string; at: number }
	| {
			kind: "tool_start";
			messageId: string;
			toolCallId: string;
			toolName: string;
			args: unknown;
			at: number;
	  }
	| {
			kind: "tool_end";
			messageId: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			at: number;
	  }
	| {
			kind: "reply_start";
			messageId: string;
			chunks: number;
			fake: boolean;
			at: number;
	  }
	| {
			kind: "reply_end";
			messageId: string;
			ok: boolean;
			sentChunks: number;
			error?: string;
			at: number;
	  }
	| { kind: "run_end"; messageId: string; at: number }
	| { kind: "error"; messageId?: string; stage: string; message: string; at: number };

/** Optional observer owned by one Pi TUI process. */
export interface QQConversationObserver {
	onEvent(event: QQTerminalEvent): void;
	dispose(): void;
}
