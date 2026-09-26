/**
 * Mid-turn steer inbox — the client posts user messages while a turn streams;
 * the turn's stage handler drains one unit per inject-capable stage.
 *
 * @module
 */

import { type StageHandler, TheoremError, type TurnHistoryMessage } from '../../../mod.ts';
import { isRecord } from '../../../src/kernel/util/record.ts';

/** One steer: the client's id for it, reported back in `stage.injected` once it lands. */
export type SteerUnit = { id: string; messages: TurnHistoryMessage[] };

/** The stages a steer can land at. */
const STEER_STAGES: ReadonlySet<string> = new Set(['pre_turn', 'post_tool', 'before_end']);

/**
 * A steer as a client posts it (`{ id, inject }`): a non-empty id and at least
 * one user message. Other roles are dropped — a client never injects system,
 * assistant or tool turns.
 */
export function parseSteerUnit(body: unknown): SteerUnit {
	const id = isRecord(body) && typeof body.id === 'string' ? body.id.trim() : '';
	// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
	if (!id) throw new TheoremError('request', 'id is required');
	if (!isRecord(body) || !Array.isArray(body.inject) || body.inject.length === 0) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'inject must be a non-empty array');
	}
	const messages = body.inject.filter(
		(message): message is TurnHistoryMessage => isRecord(message) && message.role === 'user',
	);
	// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
	if (!messages.length) throw new TheoremError('request', 'inject must contain user messages');
	return { id, messages };
}

/** Lands the inbox's next steer, one per steerable stage, named by its id. */
export function steerStage(inbox: SteerInbox, key: string): StageHandler {
	return async ({ stage }) => {
		if (!STEER_STAGES.has(stage)) return;
		const unit = await inbox.consume(key);
		return unit ? { inject: unit.messages, injectId: unit.id } : undefined;
	};
}

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
			queue.push(structuredClone(unit));
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
