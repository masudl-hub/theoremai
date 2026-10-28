import { DEFAULT_MAX_OUTCOME_BYTES, labelText, TheoremError } from '@theoremjs/agents';
import type { TheoremSessionState } from './session-store.ts';

/** What a session store holds for one session, in bytes of UTF-8 JSON. The store declares it. */
export interface TheoremSessionCapacity {
  /** The most one session's saved state may take. */
  maxStateBytes: number;
  /** The most one tool result may take. Room for one is kept for each call that has not settled. */
  maxOutcomeBytes: number;
}

/** The memory store's default: room for sixteen full-size tool results in each session. */
export const DEFAULT_SESSION_CAPACITY: TheoremSessionCapacity = {
  maxStateBytes: 16 * DEFAULT_MAX_OUTCOME_BYTES,
  maxOutcomeBytes: DEFAULT_MAX_OUTCOME_BYTES,
};

/** The store's declared capacity, refused as `config` unless both are positive and one result fits. */
export function checkedCapacity(capacity: unknown): TheoremSessionCapacity {
  const { maxStateBytes, maxOutcomeBytes } = (capacity ?? {}) as Partial<TheoremSessionCapacity>;
  if (
    !Number.isSafeInteger(maxStateBytes) ||
    !Number.isSafeInteger(maxOutcomeBytes) ||
    (maxOutcomeBytes as number) <= 0 ||
    (maxStateBytes as number) < (maxOutcomeBytes as number)
  ) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'session_store_capacity_declared' },
    });
  }
  return { maxStateBytes: maxStateBytes as number, maxOutcomeBytes: maxOutcomeBytes as number };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** The bytes the state takes with room kept for the result of each gate and each call that has not settled. */
function needed(state: TheoremSessionState, capacity: TheoremSessionCapacity): number {
  const open =
    Object.keys(state.gates).length +
    Object.values(state.operations).filter((operation) => operation.status !== 'settled').length;
  return bytes(state) + open * capacity.maxOutcomeBytes;
}

/**
 * Fits the state in the store's capacity: drops the oldest settled results, then the oldest
 * provider checkpoints, and refuses with `session.full` when open work alone does not fit.
 *
 * invariant: Gates, permissions and calls that have not settled are never dropped to make room.
 */
export function fitSession(state: TheoremSessionState, capacity: TheoremSessionCapacity): void {
  if (needed(state, capacity) <= capacity.maxStateBytes) return;
  const settled = Object.values(state.operations)
    .flatMap((operation) => (operation.status === 'settled' ? [operation] : []))
    .sort((a, b) => a.settledAt - b.settledAt);
  for (const operation of settled) {
    delete state.operations[operation.operationId];
    if (needed(state, capacity) <= capacity.maxStateBytes) return;
  }
  while (state.providerCheckpoints.length) {
    state.providerCheckpoints.shift();
    if (needed(state, capacity) <= capacity.maxStateBytes) return;
  }
  const need = needed(state, capacity);
  throw new TheoremError(
    'unavailable',
    `The session's open work needs ${need} bytes with room for its results, more than the store's maxStateBytes of ${capacity.maxStateBytes}`, // labels-exempt: internal diagnostic; the user reads session.full
    {
      copy: { key: 'session.full' },
      cause: { code: 'session_state_capacity', need, maxStateBytes: capacity.maxStateBytes },
    },
  );
}
