/**
 * Server-held session state for `createTheoremHandler`.
 *
 * Everything that grants authority lives here, never in the request body:
 * which tools the user allowed for the session, which paused tool calls may be
 * resumed (and with exactly what input), and which provider interactions this
 * session may continue.
 *
 * @module
 */

import {
  jsonObjectSchema,
  jsonValueSchema,
  labelText,
  savedToolInvocationSchema,
  TheoremError,
  TOOL_AUTH_TYPES,
  TOOL_GATE_KINDS,
  TOOL_PERMISSION,
  toolOperationOutcomeSchema,
  turnHistoryMessageSchema,
  turnToolSnapshotSchema,
  z,
} from '@theoremjs/agents';
import type { ToolGateAuth } from '@theoremjs/agents/interface';
import type {
  AnsweredGate,
  ToolGate,
  ToolId,
  ToolOperationIdentity,
  ToolOperationOutcome,
  ToolOperationUncertainty,
  TurnInput,
  TurnToolSnapshot,
} from '@theoremjs/agents/kernel';
import { gateExpired } from '@theoremjs/agents/kernel';
import {
  checkedCapacity,
  DEFAULT_SESSION_CAPACITY,
  type TheoremSessionCapacity,
} from './session-limits.ts';

/** A tool call the kernel paused on a gate, as the server saw it. */
export type PendingToolGate = {
  profileId: string;
  operationId: string;
  callId: string;
  name: string;
  /** The model's arguments; an approval runs the call with exactly these. */
  arguments: Record<string, unknown>;
  /** The gate, and for a sign-in gate the credential slot and kind it waits for. */
  gate: Pick<ToolGate, 'kind' | 'permission'> & { auth?: ToolGateAuth };
  snapshot?: TurnToolSnapshot;
  promoted: ToolId[];
  turnInput: TurnInput;
  model?: string;
  createdAt: number;
  expiresAt?: number;
};

export type SessionPageGrant = { grantId: string; expiresAt: number; resultHash?: string };

export type SessionToolOperation =
  | {
      status: 'ready';
      profileId: string;
      pending: PendingToolGate;
      answer: Omit<AnsweredGate, 'typed'>;
      readyAt: number;
    }
  | (ToolOperationIdentity & {
      status: 'running';
      claimToken: string;
      startedAt: number;
      pageGrant?: SessionPageGrant;
    })
  | (ToolOperationIdentity & {
      status: 'settled';
      pageGrant?: SessionPageGrant;
      outcome: ToolOperationOutcome;
      settledAt: number;
      retainUntil?: number;
    })
  | (ToolOperationIdentity & {
      status: 'uncertain';
      pageGrant?: SessionPageGrant;
      claimToken: string;
      reason: ToolOperationUncertainty;
      detectedAt: number;
    });

export const DEFAULT_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

export type TheoremSessionState = {
  version: 3;
  operations: Record<string, SessionToolOperation>;
  /** Tool ids the user allowed for the rest of this session. */
  permissions: string[];
  /** invariant: Operation IDs index issued gates; both IDs must match an answer. */
  gates: Record<string, PendingToolGate>;
  /** Checkpoint identities this session produced, newest last. */
  providerCheckpoints: string[];
};

const blobSchema = z.strictObject({
  data: z.string(),
  mimeType: z.string(),
  name: z.string().optional(),
});
const inputSchema: z.ZodType<TurnInput> = z.strictObject({
  text: z.string().optional(),
  role: z.string().optional(),
  slots: z.record(z.string(), z.string()).optional(),
  context: z
    .strictObject({ client: jsonValueSchema.optional(), server: jsonValueSchema.optional() })
    .optional(),
  attachments: z
    .array(
      z.union([
        blobSchema,
        z.strictObject({
          uri: z.string(),
          mimeType: z.string(),
          name: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  voice: z.array(blobSchema).optional(),
  history: z.array(turnHistoryMessageSchema).optional(),
  repair: z
    .strictObject({ previousOutput: z.string(), rejection: z.string(), guidance: z.string() })
    .optional(),
  historyTokens: z.number().nonnegative().optional(),
  inputTokens: z.number().nonnegative().optional(),
});
const pendingSchema: z.ZodType<PendingToolGate> = z.strictObject({
  profileId: z.string().min(1),
  operationId: z.string().min(1).max(256),
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: jsonObjectSchema,
  gate: z
    .strictObject({
      kind: z.enum(TOOL_GATE_KINDS),
      permission: z.enum(TOOL_PERMISSION).optional(),
      auth: z
        .strictObject({
          slot: z.string().min(1),
          authType: z.enum(TOOL_AUTH_TYPES),
          service: z.string().min(1),
        })
        .optional(),
    })
    .superRefine((gate, ctx) => {
      if ((gate.kind === 'auth') !== (gate.auth !== undefined)) {
        ctx.addIssue({ code: 'custom', path: ['auth'] });
      }
    }),
  snapshot: turnToolSnapshotSchema.optional(),
  promoted: z.array(z.string().min(1)),
  turnInput: inputSchema,
  model: z.string().optional(),
  createdAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().nonnegative().optional(),
});

const acceptedAnswerSchema: z.ZodType<Omit<AnsweredGate, 'typed'>> = z.strictObject({
  input: jsonObjectSchema,
  resume: z.strictObject({
    granted: z.boolean().optional(),
    gateKind: z.enum(TOOL_GATE_KINDS).optional(),
    cause: z.enum(['declined', 'abandoned', 'expired']).optional(),
    signIn: z.boolean().optional(),
    edited: z.strictObject({ from: jsonObjectSchema }).optional(),
  }),
  sessionPermissions: z.array(z.string().min(1)),
  page: z
    .union([
      z.strictObject({ output: jsonValueSchema }),
      z.strictObject({ timedOut: z.literal(true) }),
      z.strictObject({ unanswered: z.literal(true) }),
    ])
    .optional(),
});
const identityFields = {
  operationId: z.string().min(1).max(256),
  callId: z.string().min(1),
  profileId: z.string().min(1),
  toolId: z.string().min(1),
  invocationHash: z.string().min(1),
  invocation: savedToolInvocationSchema.optional(),
};
const pageGrant = z.strictObject({
  grantId: z.string().min(1),
  expiresAt: z.number().finite().positive(),
  resultHash: z.string().optional(),
});
const operationSchema: z.ZodType<SessionToolOperation> = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    profileId: z.string().min(1),
    pending: pendingSchema,
    answer: acceptedAnswerSchema,
    readyAt: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    ...identityFields,
    status: z.literal('running'),
    pageGrant: pageGrant.optional(),
    claimToken: z.string().min(1),
    startedAt: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    ...identityFields,
    status: z.literal('settled'),
    pageGrant: pageGrant.optional(),
    outcome: toolOperationOutcomeSchema,
    settledAt: z.number().finite().nonnegative(),
    retainUntil: z.number().finite().nonnegative().optional(),
  }),
  z.strictObject({
    ...identityFields,
    status: z.literal('uncertain'),
    pageGrant: pageGrant.optional(),
    claimToken: z.string().min(1),
    reason: z.enum(['execution_interrupted', 'settlement_write_failed', 'worker_lost']),
    detectedAt: z.number().finite().nonnegative(),
  }),
]);

/** Stored authority is checked before the handler reads or changes it. */
export const theoremSessionStateSchema: z.ZodType<TheoremSessionState> = z
  .strictObject({
    version: z.literal(3),
    operations: z.record(z.string().min(1), operationSchema),
    permissions: z.array(z.string().min(1)),
    gates: z.record(z.string().min(1), pendingSchema),
    providerCheckpoints: z.array(z.string().min(1)),
  })
  .superRefine((state, ctx) => {
    for (const [operationId, operation] of Object.entries(state.operations)) {
      const reference = operation.status === 'ready' ? operation.pending : operation;
      if (
        reference.operationId !== operationId ||
        (operation.status === 'ready' && operation.profileId !== operation.pending.profileId) ||
        operationId in state.gates ||
        (operation.status === 'settled' &&
          (operation.outcome.event.tool.operationId !== operationId ||
            operation.outcome.event.tool.callId !== operation.callId ||
            operation.outcome.event.tool.name !== operation.toolId))
      ) {
        ctx.addIssue({ code: 'custom', path: ['operations', operationId] });
      }
    }
    for (const [operationId, gate] of Object.entries(state.gates)) {
      if (operationId !== gate.operationId)
        ctx.addIssue({ code: 'custom', path: ['gates', operationId] });
    }
  });

export interface SessionSnapshot {
  revision: string;
  state: TheoremSessionState;
}

export type SessionWriteResult = { written: true; revision: string } | { written: false };

/**
 * Where session state lives. The default is process memory — use a shared
 * store (KV, Redis, a database row) when requests can reach different instances.
 */
export interface TheoremSessionStore {
  /** What it holds for one session. The handler fits each write to it before `compareAndSwap`. */
  readonly capacity: TheoremSessionCapacity;
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  /** Compare and replace atomically; null creates only an absent session. */
  compareAndSwap(
    sessionId: string,
    expectedRevision: string | null,
    next: TheoremSessionState,
  ): Promise<SessionWriteResult>;
}

export function emptySessionState(): TheoremSessionState {
  return {
    version: 3,
    operations: {},
    permissions: [],
    gates: {},
    providerCheckpoints: [],
  };
}

/** Drop gates (waiting or settled) older than `ttlMs`. */
export function pruneGates<Gate extends { createdAt: number; expiresAt?: number }>(
  gates: Record<string, Gate>,
  now: number,
  ttlMs: number,
): Record<string, Gate> {
  return Object.fromEntries(
    Object.entries(gates).filter(([, gate]) =>
      gate.expiresAt !== undefined
        ? now < gate.expiresAt
        : !gateExpired(gate.createdAt, now, ttlMs),
    ),
  );
}

export type MemorySessionStoreOptions = {
  /** What it holds for one session. Default {@linkcode DEFAULT_SESSION_CAPACITY}. */
  capacity?: Partial<TheoremSessionCapacity>;
  /** invariant: Idle retention is in milliseconds. Protected authority remains. Default 24h. */
  ttlMs?: number;
  /** Oldest sessions are evicted past this count. Default 10 000. */
  maxSessions?: number;
};

export function memoryStoreLimits(options: MemorySessionStoreOptions) {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 10_000;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions <= 0
  ) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'session_store_options', ttlMs, maxSessions },
    });
  }
  return { ttlMs, maxSessions };
}

/** A value kept per session id for the separate credential store. */
export type PerSessionStore<T> = {
  load(sessionId: string): T | undefined | Promise<T | undefined>;
  save(sessionId: string, value: T): void | Promise<void>;
};

/** A per-session value kept in process memory: forgotten when idle, oldest evicted first. */
export function createMemorySessionMap<T>(options: MemorySessionStoreOptions = {}): {
  load(sessionId: string): T | undefined;
  save(sessionId: string, value: T): void;
} {
  const { ttlMs, maxSessions } = memoryStoreLimits(options);
  const sessions = new Map<string, { value: T; touched: number }>();
  return {
    load(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return undefined;
      if (Date.now() - entry.touched > ttlMs) {
        sessions.delete(sessionId);
        return undefined;
      }
      return structuredClone(entry.value);
    },
    save(sessionId, value) {
      sessions.delete(sessionId);
      sessions.set(sessionId, { value: structuredClone(value), touched: Date.now() });
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
  };
}

export function createMemorySessionStore(
  options: MemorySessionStoreOptions = {},
): TheoremSessionStore {
  const { ttlMs, maxSessions } = memoryStoreLimits(options);
  const capacity = checkedCapacity({ ...DEFAULT_SESSION_CAPACITY, ...options.capacity });
  const sessions = new Map<string, { snapshot: SessionSnapshot; touched: number }>();
  const held = (entry: { snapshot: SessionSnapshot }) =>
    Object.values(entry.snapshot.state.gates).some(
      (gate) => gate.expiresAt === undefined || Date.now() < gate.expiresAt,
    ) ||
    Object.values(entry.snapshot.state.operations).some(
      (operation) =>
        operation.status !== 'settled' ||
        Date.now() <
          (operation.retainUntil ?? operation.settledAt + DEFAULT_OPERATION_RETENTION_MS),
    );
  const current = (sessionId: string) => {
    const entry = sessions.get(sessionId);
    if (entry && !held(entry) && Date.now() - entry.touched >= ttlMs) {
      sessions.delete(sessionId);
      return undefined;
    }
    return entry?.snapshot;
  };
  return {
    capacity,
    load(sessionId) {
      return Promise.resolve(structuredClone(current(sessionId)));
    },
    compareAndSwap(sessionId, expectedRevision, next) {
      const snapshot = current(sessionId);
      if ((snapshot?.revision ?? null) !== expectedRevision)
        return Promise.resolve({ written: false });
      const state = theoremSessionStateSchema.parse(next);
      if (!snapshot && sessions.size >= maxSessions) {
        const removable = [...sessions].find(([, entry]) => !held(entry));
        if (!removable) {
          throw new TheoremError(
            'unavailable',
            `The memory session store holds ${maxSessions} sessions and each has work in progress, so a new one was not saved`, // labels-exempt: internal diagnostic; the user reads session.busy
            { copy: { key: 'session.busy' }, cause: { code: 'session_store_capacity' } },
          );
        }
        sessions.delete(removable[0]);
      }
      const revision = crypto.randomUUID();
      sessions.delete(sessionId);
      sessions.set(sessionId, {
        snapshot: { revision, state: structuredClone(state) },
        touched: Date.now(),
      });
      return Promise.resolve({ written: true, revision });
    },
  };
}
