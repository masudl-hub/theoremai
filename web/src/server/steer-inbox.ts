/**
 * Mid-turn steer inbox — the client posts user messages while a turn streams;
 * the turn's stage handler drains one unit per inject-capable stage. The
 * client's stop reaches the turn through it too.
 *
 * @module
 */

import { type StageHandler, TheoremError, type TurnHistoryMessage } from '@theoremjs/agents';
import type { TheoremSteerRequest } from '../client/transport.ts';

/** One steer: the client's id for it, reported back in `stage.injected` once it lands. */
export type SteerUnit = { id: string; messages: TurnHistoryMessage[] };

/** The stages a steer can land at. */
const STEER_STAGES: ReadonlySet<string> = new Set(['pre_turn', 'post_tool', 'before_end']);

/**
 * A steer as a client posts it (a checked `TheoremSteerRequest`): its user
 * messages. Other roles are dropped — a client never injects system,
 * assistant or tool turns — and a steer with no user message is refused.
 */
export function steerUnitOf(steer: Pick<TheoremSteerRequest, 'id' | 'inject'>): SteerUnit {
  const messages = steer.inject.filter((message) => message.role === 'user');
  // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
  if (!messages.length) throw new TheoremError('request', 'inject must contain user messages');
  return { id: steer.id, messages };
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
 * correct when steer and stop POSTs reach the same process as the turn — swap
 * in a shared store (KV, Redis, Durable Object) for multi-instance hosts.
 */
export interface SteerInbox {
  open(turnId: string): void | Promise<void>;
  /** Returns `false` when no turn with this id is open. */
  enqueue(turnId: string, unit: SteerUnit): boolean | Promise<boolean>;
  /** Next unit, FIFO, or `undefined`. */
  consume(turnId: string): SteerUnit | undefined | Promise<SteerUnit | undefined>;
  /** Stops the turn. Returns `false` when no turn with this id is open. */
  stop(turnId: string): boolean | Promise<boolean>;
  /** Settles `true` once the turn is stopped (at once if it already is), `false` once it closes. */
  stopped(turnId: string): Promise<boolean>;
  close(turnId: string): void | Promise<void>;
}

type MemoryTurn = { queue: SteerUnit[]; stopped: boolean; settle: Set<(stopped: boolean) => void> };

export function createMemorySteerInbox(): SteerInbox {
  const turns = new Map<string, MemoryTurn>();
  return {
    open(turnId) {
      if (!turns.has(turnId)) turns.set(turnId, { queue: [], stopped: false, settle: new Set() });
    },
    enqueue(turnId, unit) {
      const turn = turns.get(turnId);
      if (!turn) return false;
      turn.queue.push(structuredClone(unit));
      return true;
    },
    consume(turnId) {
      return turns.get(turnId)?.queue.shift();
    },
    stop(turnId) {
      const turn = turns.get(turnId);
      if (!turn) return false;
      turn.stopped = true;
      for (const settle of turn.settle) settle(true);
      turn.settle.clear();
      return true;
    },
    stopped(turnId) {
      const turn = turns.get(turnId);
      if (!turn) return Promise.resolve(false);
      if (turn.stopped) return Promise.resolve(true);
      return new Promise((resolve) => turn.settle.add(resolve));
    },
    close(turnId) {
      const turn = turns.get(turnId);
      for (const settle of turn?.settle ?? []) settle(false);
      turns.delete(turnId);
    },
  };
}

/** Aborts `stop` once the inbox's turn is stopped. */
export function stopOnRequest(inbox: SteerInbox, turnId: string, stop: AbortController): void {
  inbox.stopped(turnId).then(
    (stopped) => {
      if (stopped) stop.abort();
    },
    // why: An inbox that can't say leaves the turn to run; the browser's fallback drops the stream.
    () => {},
  );
}
