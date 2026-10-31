import {
  type ErrorKind,
  jsonValueSchema,
  labelText,
  type PageAnswer,
  type PageToolExecution,
  TheoremError,
  type ToolOperationClaim,
  toolInvocationHash,
  z,
} from '@theoremjs/agents';
import type { MutableStore } from './session-authority.ts';
import type { TheoremSessionState } from './session-store.ts';

export type PageToolResult = {
  callId: string;
  operationId: string;
  grantId: string;
  page: PageAnswer;
};
export const pageToolResultSchema: z.ZodType<PageToolResult> = z.strictObject({
  callId: z.string().min(1),
  operationId: z.string().min(1).max(256),
  grantId: z.string().min(1),
  page: z.union([
    z.strictObject({ output: jsonValueSchema }),
    z.strictObject({ unanswered: z.literal(true) }),
    z.strictObject({ timedOut: z.literal(true) }),
  ]),
});

export interface PageToolBroker {
  reserve(
    sessionId: string,
    grantId: string,
    signal?: AbortSignal,
  ): {
    result: Promise<PageAnswer>;
    cancel(): void;
  };
  deliver(sessionId: string, grantId: string, page: PageAnswer): Promise<void>;
}

/** The user reads that the action is unresolved; the builder reads why, under the kind of what happened. */
function refused(kind: ErrorKind, reason: string): never {
  throw new TheoremError(kind, reason, { copy: { key: 'tool.execution_uncertain' } });
}

export function createMemoryPageToolBroker(maxPending = 128): PageToolBroker {
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0)
    throw new TheoremError('config', labelText('error.config'));
  const waiting = new Map<string, (answer: PageAnswer) => void>();
  const key = (sessionId: string, grantId: string) => JSON.stringify([sessionId, grantId]);
  return {
    reserve(sessionId, grantId, signal) {
      const id = key(sessionId, grantId);
      if (signal?.aborted) refused('cancelled', 'The page dispatch was stopped before it was sent'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      if (waiting.has(id)) refused('internal', 'The page broker already waits for this grant'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      if (waiting.size >= maxPending)
        refused(
          'rate_limit',
          `The page broker already waits for its maxPending of ${maxPending} answers`,
        ); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      let finish: (answer: PageAnswer) => void = () => {};
      const result = new Promise<PageAnswer>((resolve) => {
        finish = resolve;
      });
      const cancel = () => {
        waiting.delete(id);
        signal?.removeEventListener('abort', cancel);
        finish({ timedOut: true });
      };
      waiting.set(id, (answer) => {
        waiting.delete(id);
        signal?.removeEventListener('abort', cancel);
        finish(answer);
      });
      signal?.addEventListener('abort', cancel, { once: true });
      return { result, cancel };
    },
    deliver(sessionId, grantId, page) {
      const finish = waiting.get(key(sessionId, grantId));
      if (!finish)
        return Promise.reject(
          new TheoremError(
            'conflict',
            'No dispatch in this process waits for the page answer to this grant', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
            { copy: { key: 'tool.execution_uncertain' } },
          ),
        );
      finish(page);
      return Promise.resolve();
    },
  };
}

/** Refuses a page tool timeout that is not a whole number of milliseconds a timer can hold. */
export function checkPageToolTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
  )
    throw new TheoremError('config', labelText('error.config'));
}

export function sessionPageDispatch(
  store: MutableStore<TheoremSessionState>,
  sessionId: string,
  broker: PageToolBroker,
  timeoutMs?: number,
): { execution: PageToolExecution; answer(result: PageToolResult): Promise<boolean> } {
  checkPageToolTimeout(timeoutMs);
  return {
    execution: {
      async dispatch(claim: ToolOperationClaim, signal) {
        if (!claim.invocation)
          refused('internal', 'The page dispatch got a claim with no invocation'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        const grantId = crypto.randomUUID();
        const expiresAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
        const pending = broker.reserve(sessionId, grantId, signal);
        try {
          await store.mutate(sessionId, (state) => {
            const record = state.operations[claim.operationId];
            if (
              record?.status !== 'running' ||
              record.claimToken !== claim.claimToken ||
              record.invocationHash !== claim.invocationHash ||
              record.pageGrant
            )
              refused(
                'internal',
                'The session store holds no running claim for this page dispatch', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
              );
            record.pageGrant = { grantId, ...(expiresAt === undefined ? {} : { expiresAt }) };
          });
        } catch (error) {
          pending.cancel();
          throw error;
        }
        const remaining = expiresAt === undefined ? undefined : expiresAt - Date.now();
        if ((remaining !== undefined && remaining <= 0) || signal?.aborted) {
          pending.cancel();
          if (signal?.aborted)
            refused('cancelled', 'The page dispatch was stopped before it was sent'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          refused('timeout', 'The page dispatch used its timeoutMs before it was sent'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        }
        let expire = () => {};
        const expired = new Promise<PageAnswer>((resolve) => {
          expire = () => resolve({ timedOut: true });
        });
        const timer = remaining === undefined ? undefined : setTimeout(expire, remaining);
        signal?.addEventListener('abort', expire, { once: true });
        return {
          grantId,
          result: Promise.race([pending.result, expired]).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', expire);
            pending.cancel();
          }),
        };
      },
    },
    async answer(raw) {
      const result = pageToolResultSchema.parse(raw);
      const hash = await toolInvocationHash(result.page);
      const duplicate = await store.mutate(sessionId, (state) => {
        const record = state.operations[result.operationId];
        if (
          !record ||
          record.status === 'ready' ||
          record.callId !== result.callId ||
          record.pageGrant?.grantId !== result.grantId
        )
          refused('request', 'The page answered a grant this session did not issue for that call'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        if (record.pageGrant.resultHash !== undefined) {
          if (record.pageGrant.resultHash !== hash)
            refused('request', 'The page answered this grant twice with different results'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          if (record.status === 'uncertain')
            refused('request', 'The page answered again for a call that is uncertain'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
          return { duplicate: true, settled: record.status === 'settled' };
        }
        if (record.status !== 'running')
          refused('request', `The page answered a call that is ${record.status}, not running`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        if (record.pageGrant.expiresAt !== undefined && Date.now() >= record.pageGrant.expiresAt)
          refused('timeout', 'The page answered after its grant expired'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        record.pageGrant.resultHash = hash;
        return { duplicate: false, settled: false };
      });
      if (!duplicate.duplicate) await broker.deliver(sessionId, result.grantId, result.page);
      return duplicate.settled;
    },
  };
}
