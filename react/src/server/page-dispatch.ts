import {
  jsonValueSchema,
  lexiconText,
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

function unavailable(): never {
  throw new TheoremError('unavailable', lexiconText('tool.execution_uncertain'), {
    copy: { key: 'tool.execution_uncertain' },
  });
}

export function createMemoryPageToolBroker(maxPending = 128): PageToolBroker {
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0)
    throw new TheoremError('config', lexiconText('error.config'));
  const waiting = new Map<string, (answer: PageAnswer) => void>();
  const key = (sessionId: string, grantId: string) => JSON.stringify([sessionId, grantId]);
  return {
    reserve(sessionId, grantId, signal) {
      const id = key(sessionId, grantId);
      if (signal?.aborted || waiting.has(id) || waiting.size >= maxPending) unavailable();
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
          new TheoremError('unavailable', lexiconText('tool.execution_uncertain')),
        );
      finish(page);
      return Promise.resolve();
    },
  };
}

export function sessionPageDispatch(
  store: MutableStore<TheoremSessionState>,
  sessionId: string,
  broker: PageToolBroker,
  timeoutMs = 20_000,
): { execution: PageToolExecution; answer(result: PageToolResult): Promise<boolean> } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new TheoremError('config', lexiconText('error.config'));
  return {
    execution: {
      async dispatch(claim: ToolOperationClaim, signal) {
        if (!claim.invocation) unavailable();
        const grantId = crypto.randomUUID();
        const expiresAt = Date.now() + timeoutMs;
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
              unavailable();
            record.pageGrant = { grantId, expiresAt };
          });
        } catch (error) {
          pending.cancel();
          throw error;
        }
        const remaining = expiresAt - Date.now();
        if (remaining <= 0 || signal?.aborted) {
          pending.cancel();
          unavailable();
        }
        let expire = () => {};
        const expired = new Promise<PageAnswer>((resolve) => {
          expire = () => resolve({ timedOut: true });
        });
        const timer = setTimeout(expire, remaining);
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
          unavailable();
        if (record.pageGrant.resultHash !== undefined) {
          if (record.pageGrant.resultHash !== hash) unavailable();
          if (record.status === 'uncertain') unavailable();
          return { duplicate: true, settled: record.status === 'settled' };
        }
        if (record.status !== 'running' || Date.now() >= record.pageGrant.expiresAt) unavailable();
        record.pageGrant.resultHash = hash;
        return { duplicate: false, settled: false };
      });
      if (!duplicate.duplicate) await broker.deliver(sessionId, result.grantId, result.page);
      return duplicate.settled;
    },
  };
}
