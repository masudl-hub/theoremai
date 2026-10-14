import {
  labelText,
  type PageToolExecution,
  type ProviderCheckpoint,
  type SessionRequest,
  TheoremError,
  type ToolExecutionCoordinator,
  type TurnHistoryMessage,
} from '@theoremjs/agents';
import { resolveGateTtlMs } from '@theoremjs/agents/kernel';
import { type LiveOpenMessage, liveOpenMessageSchema } from '../client/live-messages.ts';
import {
  checkpointIdentity,
  checkpointOwnershipKey,
  requireOwnedCheckpoint,
  retainedCheckpointIdentities,
} from './checkpoint-ownership.ts';
import {
  createMemoryPageToolBroker,
  type PageToolBroker,
  type PageToolResult,
  sessionPageDispatch,
} from './page-dispatch.ts';
import { checkRequest } from './request-check.ts';
import { sessionStateStore } from './session-authority.ts';
import { theoremSession } from './session-identity.ts';
import { resolveSessionLimits, type TheoremSessionLimits } from './session-limits.ts';
import { DEFAULT_OPERATION_RETENTION_MS, type TheoremSessionStore } from './session-store.ts';
import { sessionToolCoordinator } from './tool-operations.ts';
import { liveSessionOpen } from './turn-input.ts';

export interface SessionBoundaryOptions {
  request: Request;
  session?: (request: Request) => string | undefined | Promise<string | undefined>;
  sessionStore: TheoremSessionStore;
  gateTtlMs?: number;
  operationRetentionMs?: number;
  sessionLimits?: Partial<TheoremSessionLimits>;
  pageToolBroker?: PageToolBroker;
}

export type PreparedLiveOpen = Pick<
  SessionRequest,
  'history' | 'slots' | 'context' | 'providerState' | 'awayMs'
>;

export interface TheoremSessionBoundary {
  sessionId: string;
  setCookie?: string;
  prepareLiveOpen(open: LiveOpenMessage, serverContext?: unknown): Promise<PreparedLiveOpen>;
  prepareProviderState(
    checkpoint: ProviderCheckpoint | undefined,
    history?: readonly TurnHistoryMessage[],
  ): Promise<ProviderCheckpoint | undefined>;
  recordCheckpoint(checkpoint: ProviderCheckpoint): Promise<void>;
  toolExecution: ToolExecutionCoordinator;
  pageExecution: PageToolExecution;
  answerPageResult(result: PageToolResult): Promise<boolean>;
}

export async function createTheoremSessionBoundary(
  options: SessionBoundaryOptions,
): Promise<TheoremSessionBoundary> {
  const cookie = options.session ? undefined : theoremSession(options.request);
  const id = options.session ? (await options.session(options.request))?.trim() : cookie?.id;
  if (!id)
    throw new TheoremError('auth', labelText('session.sign_in'), {
      copy: { key: 'session.sign_in' },
    });
  const retention = options.operationRetentionMs ?? DEFAULT_OPERATION_RETENTION_MS;
  if (!Number.isSafeInteger(retention) || retention <= 0)
    throw new TheoremError('config', labelText('error.config'));
  const limits = resolveSessionLimits(options.sessionLimits);
  const store = sessionStateStore(
    options.sessionStore,
    resolveGateTtlMs('session boundary', options.gateTtlMs),
    retention,
    limits,
  );
  // invariant: Refuse unavailable or malformed authority before an upstream connection opens.
  await store.read(id);
  const page = sessionPageDispatch(
    store,
    id,
    options.pageToolBroker ?? createMemoryPageToolBroker(),
  );
  return {
    pageExecution: page.execution,
    answerPageResult: page.answer,
    sessionId: id,
    ...(cookie?.setCookie ? { setCookie: cookie.setCookie } : {}),
    toolExecution: sessionToolCoordinator(store, id),
    async prepareLiveOpen(raw, server) {
      const open = checkRequest(liveOpenMessageSchema, raw, 'live open');
      const prepared = liveSessionOpen(open, server);
      const state = await store.read(id);
      const providerState = await requireOwnedCheckpoint(
        state.providerCheckpoints,
        prepared.providerState,
        state.operations,
      );
      if (
        providerState &&
        Object.values(state.operations).some((operation) => operation.status !== 'settled')
      ) {
        throw new TheoremError('unavailable', labelText('tool.execution_uncertain'), {
          copy: { key: 'tool.execution_uncertain' },
        });
      }
      return {
        ...prepared,
        providerState,
        ...(prepared.history
          ? { history: prepared.history.filter((message) => message.role !== 'system') }
          : {}),
      };
    },
    async prepareProviderState(checkpoint, history) {
      const state = await store.read(id);
      return requireOwnedCheckpoint(
        state.providerCheckpoints,
        checkpoint,
        state.operations,
        history,
      );
    },
    async recordCheckpoint(checkpoint) {
      const identity = await checkpointIdentity(checkpoint);
      await store.mutate(id, async (state) => {
        state.providerCheckpoints = retainedCheckpointIdentities(
          state.providerCheckpoints,
          [await checkpointOwnershipKey(identity, state.operations)],
          limits.maxCheckpoints,
        );
      });
    },
  };
}
