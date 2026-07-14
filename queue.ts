/**
 * FIFO queue that serializes complete inbound QQ messages.
 *
 * Pi has a single active session, so QQ conversations are processed one at a
 * time to avoid overlapping turns and misdirected replies. When the queue is
 * full, the newest message is dropped (the caller may send a busy notice).
 */

import type { QQInboundMessage } from "./types";

export class MessageQueue {
	private readonly pending: QQInboundMessage[] = [];
	private readonly maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = Math.max(1, maxSize);
	}

	get size(): number {
		return this.pending.length;
	}

	/**
	 * Enqueue a message. Returns true if accepted, false if dropped because the
	 * queue is full (newest is dropped).
	 */
	enqueue(msg: QQInboundMessage): boolean {
		if (this.pending.length >= this.maxSize) return false;
		this.pending.push(msg);
		return true;
	}

	dequeue(): QQInboundMessage | undefined {
		return this.pending.shift();
	}

	clear(): void {
		this.pending.length = 0;
	}
}
