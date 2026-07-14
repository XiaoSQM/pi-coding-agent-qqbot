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

export interface PiQQBotConfig {
	enabled: boolean;
	/** Connect the QQ gateway automatically on Pi startup. Default false: use /qqbot-start. */
	autoStart?: boolean;
	appId: string;
	clientSecret: string;
	sandbox?: boolean;
	allowUsers?: string[];
	allowGroups?: string[];
	replyPrefix?: string;
	maxQueueSize?: number;
	sendBusyNotice?: boolean;
	/** Allow forwarding non-qqbot pi slash commands from QQ (fire-and-forget). */
	allowCommands?: boolean;
	/** Include a compact execution summary after the final answer. */
	showProcess?: boolean;
	/** Prefer native QQ Markdown with a safe plain-text fallback, or force plain text. */
	replyFormat: QQReplyFormat;
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

export type ConnectionState =
	| "disabled"
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

export type QQAttachmentEventKind = "attachment_start" | "attachment_progress" | "attachment_end" | "attachment_rejected";

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
