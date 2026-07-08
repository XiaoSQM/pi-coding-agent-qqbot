/**
 * Shared types for the pi-qqbot extension.
 */

export interface PiQQBotConfig {
	enabled: boolean;
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
	/** Include a tool-call transcript ("process") in the QQ reply. */
	showProcess?: boolean;
	debug?: boolean;
}

/** A normalized inbound QQ message (text only for the MVP). */
export interface QQInboundMessage {
	id: string; // platform message id, required for passive reply
	type: "private" | "group";
	text: string;
	userOpenId: string; // user_openid (private) or member_openid (group)
	groupOpenId?: string;
	raw: unknown;
	receivedAt: number;
	/** Internal: locally simulated message (/qqbot-fake). Reply is not sent to QQ. */
	fake?: boolean;
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
