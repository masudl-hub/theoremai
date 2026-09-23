/**
 * Mid-turn steer inbox — the client posts user messages while a turn streams;
 * the turn's stage handler drains one unit per inject-capable stage.
 *
 * @module
 */

import type { TurnHistoryMessage } from '../../../mod.ts';

export type SteerUnit = TurnHistoryMessage[];

/**
 * Keyed by client turn id. The default lives in process memory, which is only
 * correct when steer POSTs reach the same process as the turn — swap in a
 * shared store (KV, Redis, Durable Object) for multi-instance hosts.
 */
export interface SteerInbox {
	open(turnId: string): void | Promise<void>;
	/** Returns `false` when no turn with this id is open. */
	enqueue(turnId: string, unit: SteerUnit): boolean | Promise<boolean>;
	/** Next unit, FIFO, or `undefined`. */
	consume(turnId: string): SteerUnit | undefined | Promise<SteerUnit | undefined>;
	close(turnId: string): void | Promise<void>;
}

export function createMemorySteerInbox(): SteerInbox {
	const queues = new Map<string, SteerUnit[]>();
	return {
		open(turnId) {
			if (!queues.has(turnId)) queues.set(turnId, []);
		},
		enqueue(turnId, unit) {
			const queue = queues.get(turnId);
			if (!queue) return false;
			queue.push(unit.map((message) => structuredClone(message)));
			return true;
		},
		consume(turnId) {
			return queues.get(turnId)?.shift();
		},
		close(turnId) {
			queues.delete(turnId);
		},
	};
}
