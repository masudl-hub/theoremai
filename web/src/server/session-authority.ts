import { labelText, TheoremError, z } from '@theoremjs/agents';
import { checkSessionLimits, type TheoremSessionLimits } from './session-limits.ts';
import {
  emptySessionState,
  pruneGates,
  type TheoremSessionState,
  type TheoremSessionStore,
  theoremSessionStateSchema,
} from './session-store.ts';
export type MutableStore<T> = {
  read(sessionId: string): Promise<T>;
  mutate<R>(sessionId: string, change: (value: T) => R | Promise<R>): Promise<R>;
};
/** Session state, with expired gates dropped as it loads so they can't be answered. */
export function sessionStateStore(
  store: TheoremSessionStore,
  gateTtlMs: number,
  operationRetentionMs: number,
  limits: TheoremSessionLimits,
): MutableStore<TheoremSessionState> {
  if (typeof store.compareAndSwap !== 'function') {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'session_store_contract', required: 'compareAndSwap' },
    });
  }
  const writeResult = z.discriminatedUnion('written', [
    z.strictObject({ written: z.literal(false) }),
    z.strictObject({ written: z.literal(true), revision: z.string().min(1) }),
  ]);
  const load = async (sessionId: string, now: number) => {
    const snapshot = await store.load(sessionId);
    const parsed = theoremSessionStateSchema.safeParse(
      snapshot === undefined ? emptySessionState() : snapshot.state,
    );
    if (
      !parsed.success ||
      (snapshot !== undefined && (typeof snapshot.revision !== 'string' || !snapshot.revision))
    ) {
      throw new TheoremError('config', labelText('error.config'), {
        cause: { code: 'session_store_state' },
      });
    }
    const state = structuredClone(parsed.data);
    for (const gate of Object.values(state.gates)) gate.expiresAt ??= gate.createdAt + gateTtlMs;
    state.gates = pruneGates(state.gates, now, gateTtlMs);
    for (const operation of Object.values(state.operations)) {
      if (operation.status === 'ready' && operation.answer.resume.granted === true)
        operation.answer.resume.gateKind ??= operation.pending.gate.kind;
    }
    state.operations = Object.fromEntries(
      Object.entries(state.operations).filter(
        ([, operation]) =>
          operation.status !== 'settled' ||
          now < (operation.retainUntil ?? operation.settledAt + operationRetentionMs),
      ),
    );
    return { revision: snapshot?.revision ?? null, state };
  };
  return {
    async read(sessionId) {
      return (await load(sessionId, Date.now())).state;
    },
    async mutate(sessionId, change) {
      const now = Date.now();
      for (let conflict = 0; conflict < 8; conflict++) {
        const { revision, state } = await load(sessionId, now);
        const result = await change(state);
        for (const gate of Object.values(state.gates))
          gate.expiresAt ??= gate.createdAt + gateTtlMs;
        for (const operation of Object.values(state.operations)) {
          if (operation.status === 'settled')
            operation.retainUntil ??= operation.settledAt + operationRetentionMs;
        }
        checkSessionLimits(state, limits);
        const next = theoremSessionStateSchema.safeParse(state);
        if (!next.success) {
          throw new TheoremError('config', labelText('error.config'), {
            cause: { code: 'session_store_transition' },
          });
        }
        const written = writeResult.safeParse(
          await store.compareAndSwap(sessionId, revision, next.data),
        );
        if (!written.success) {
          throw new TheoremError('config', labelText('error.config'), {
            cause: { code: 'session_store_write_result' },
          });
        }
        if (written.data.written) {
          if (written.data.revision === revision) {
            throw new TheoremError('config', labelText('error.config'), {
              cause: { code: 'session_store_revision' },
            });
          }
          return result;
        }
      }
      throw new TheoremError('unavailable', labelText('error.unavailable'), {
        cause: { code: 'session_store_contention' },
      });
    },
  };
}
