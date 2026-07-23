/**
 * FIFO queue for conversations that are not currently active.
 *
 * The router may extract messages belonging to its active QQ conversation and
 * feed them into Pi's steering queue. All other conversations preserve FIFO
 * order. When the queue is full, the newest message is dropped.
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

	hasWhere(predicate: (msg: QQInboundMessage) => boolean): boolean {
		return this.pending.some(predicate);
	}

	/** Remove and return matching messages without changing the order of either partition. */
	takeWhere(predicate: (msg: QQInboundMessage) => boolean): QQInboundMessage[] {
		const taken: QQInboundMessage[] = [];
		const retained: QQInboundMessage[] = [];
		for (const msg of this.pending) {
			(predicate(msg) ? taken : retained).push(msg);
		}
		this.pending.length = 0;
		this.pending.push(...retained);
		return taken;
	}

	removeWhere(predicate: (msg: QQInboundMessage) => boolean): number {
		return this.takeWhere(predicate).length;
	}
}
