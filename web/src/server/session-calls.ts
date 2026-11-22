/**
 * A session's tool calls, with no `Request`: each call recorded in the session, its gates saved
 * as they pause, an answered call run on, and a background call announced as it ends. The HTTP
 * handlers and the conversation core both run their calls through here.
 *
 * @module
 */

import {
  authorizeToolReplay,
  defaultKernelScope,
  type GateReference,
  invokeTool,
  jsonObjectSchema,
  labelText,
  type Profile,
  registerProfile,
  type StageHandler,
  TheoremError,
  type ToolGate,
  type ToolOperationOutcome,
  type TurnEvent,
  type TurnInput,
  type TurnWiring,
  toolInvocationHash,
} from '@theoremjs/agents';
import { withPublicLabels } from '@theoremjs/agents/guardrails';
import {
  gatedToolsFromEvents,
  promotedToolIdsFromEvents,
  type TranscriptBlock,
  toolSnapshotFromEvents,
} from '@theoremjs/agents/interface';
import {
  type AnsweredGate,
  answerGatedCall,
  type GateAnswerRequest,
  isSealedSource,
  resolveGateTtlMs,
  type ToolBackgroundService,
  type ToolCredentialSource,
} from '@theoremjs/agents/kernel';
import type { TheoremHostCallRequest } from '../client/host-transport.ts';
import type { TheoremInvokeRequest } from '../client/transport.ts';
import { type IssuedWalkAway, requiredOperationId, waitingCalls } from './conversation.ts';
import {
  type DetachedCall,
  detachedEnd,
  readerEnding,
  type SettledOperation,
} from './conversation-inbox.ts';
import type { StoredConversation, TheoremConversationStore } from './conversation-store.ts';
import {
  createMemoryCredentialStore,
  type TheoremCredentialStore,
  type TheoremCredentials,
} from './credential-store.ts';
import type { TheoremNotifier } from './notifier.ts';
import {
  checkPageToolTimeout,
  createMemoryPageToolBroker,
  type PageToolBroker,
  sessionPageDispatch,
} from './page-dispatch.ts';
import {
  lockedStore,
  type MutableStore,
  type SessionStateStore,
  sessionStateStore,
} from './session-authority.ts';
import {
  createMemorySessionStore,
  type PendingToolGate,
  type SessionToolOperation,
  type TheoremSessionState,
  type TheoremSessionStore,
} from './session-store.ts';
import { sameAcceptedAnswer, sessionToolCoordinator } from './tool-operations.ts';
import { type AppPrepare, isRefusal, preparedTurn } from './turn-wiring.ts';

/** What a run reads in place of the request that started it. */
export type CoreContext = {
  sessionId: string;
  /**
   * The app's context for tool handlers (`ctx.host`). A promise is awaited where a run reads it.
   */
  host?: unknown;
  /** Aborts the run. */
  signal: AbortSignal;
};

/** What a session's tool calls read from whoever serves them. */
/** Where a detached call's end is saved: the chat's conversation store, as its pages read it. */
export type DetachedEndings = {
  store: TheoremConversationStore;
  forReader: (event: TurnEvent) => TurnEvent;
};

export type CallsContext = {
  profile: Profile;
  sessions: SessionStateStore;
  credentials: MutableStore<TheoremCredentials>;
  pageToolBroker: PageToolBroker;
  /** Unset when the profile keeps no conversation. */
  endings?: DetachedEndings;
  options: {
    prepare?: AppPrepare;
    onStage?: StageHandler;
    pageToolTimeoutMs?: number;
    notifier?: TheoremNotifier;
    lateResultsDecider?: TurnWiring['lateResultsDecider'];
    /** The decider's wake, with no page: a reply to no message on a run of its own. */
    wake: (at: CoreContext, ref: string) => Promise<void>;
  } & CallHooks;
};

/** The app's own steps that a session's tool calls run, each for the session of `at`. */
export type CallHooks = {
  /** The service for tools with a `background` setting, for the session of `at`. */
  background?: (at: CoreContext) => ToolBackgroundService;
  /** Check current resource access before disclosing a saved tool result. Read-only. */
  authorizeToolReplay?: (
    at: CoreContext,
    operation: SettledOperation,
  ) => boolean | Promise<boolean>;
  /** The sign-in URL for an OAuth gate. */
  authorizationUrl?: (
    challenge: Extract<ToolGate, { kind: 'auth' }>['authChallenge'],
    at: CoreContext,
  ) => string | Promise<string>;
  /** Called with any error a run reports and does not throw. */
  onError?: (err: unknown, at: CoreContext) => void;
};

/** The stores and limits a session's calls run on; each is the handler option of the same name. */
export type SessionOptions = {
  sessionStore?: TheoremSessionStore;
  credentialStore?: TheoremCredentialStore;
  gateTtlMs?: number;
  operationRetentionMs: number;
  pageToolBroker?: PageToolBroker;
  pageToolTimeoutMs?: number;
  notifyRetryMs?: number;
};

/**
 * The profile, registered, and the session's stores as its calls read them. `name` is the
 * function the app called, for the error a wrong option throws.
 */
export function sessionParts(
  name: string,
  profile: Profile,
  options: SessionOptions,
): Pick<CallsContext, 'profile' | 'sessions' | 'credentials' | 'pageToolBroker'> {
  const gateTtlMs = resolveGateTtlMs(name, options.gateTtlMs);
  const { operationRetentionMs } = options;
  if (!Number.isSafeInteger(operationRetentionMs) || operationRetentionMs <= 0) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'operation_retention' },
    });
  }
  checkPageToolTimeout(options.pageToolTimeoutMs);
  const retryMs = options.notifyRetryMs;
  if (retryMs !== undefined && !(Number.isFinite(retryMs) && retryMs >= 0)) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'notify_retry' },
    });
  }
  registerProfile(profile);
  return {
    profile,
    pageToolBroker: options.pageToolBroker ?? createMemoryPageToolBroker(),
    sessions: sessionStateStore(
      options.sessionStore ?? createMemorySessionStore(),
      gateTtlMs,
      operationRetentionMs,
    ),
    credentials: lockedStore(
      options.credentialStore ?? createMemoryCredentialStore(),
      (saved = {}) => saved,
    ),
  };
}

/** What a turn's saved outcome records beside its events. */
export type OutcomeContext = {
  profileId: string;
  turnInput: TurnInput;
  model?: string;
  promoted?: string[];
};

/** The exact paused calls the user may now approve, when the stream stopped on gates. */
function pendingGatesFrom(
  events: TurnEvent[],
  context: OutcomeContext,
): { callId: string; gate: PendingToolGate }[] {
  return gatedToolsFromEvents(events).map((gated) => ({
    callId: gated.callId,
    gate: {
      profileId: context.profileId,
      operationId: requiredOperationId(gated),
      callId: gated.callId,
      name: gated.name,
      arguments: gated.arguments,
      gate: {
        kind: gated.gateKind,
        permission: gated.permission,
        ...(gated.auth ? { auth: gated.auth } : {}),
      },
      snapshot: toolSnapshotFromEvents(events),
      promoted: [...new Set([...(context.promoted ?? []), ...promotedToolIdsFromEvents(events)])],
      turnInput: context.turnInput,
      model: context.model,
      createdAt: Date.now(),
    },
  }));
}

/** When the stream paused on gates, record the exact calls the user may now approve. */
async function recordOutcome(
  sessions: MutableStore<TheoremSessionState>,
  sessionId: string,
  events: TurnEvent[],
  context: OutcomeContext,
): Promise<void> {
  const pending = pendingGatesFrom(events, context);
  if (!pending.length) return;
  await sessions.mutate(sessionId, (state) => {
    for (const { gate } of pending) {
      const operation = state.operations[gate.operationId];
      if (operation && operation.status !== 'ready')
        throw new TheoremError(
          'unavailable',
          `Tool operation ${gate.operationId} is ${operation.status}, not ready, so its gate was not saved`, // labels-exempt: internal diagnostic; the user reads session.busy
          { copy: { key: 'session.busy' } },
        );
      delete state.operations[gate.operationId];
      Object.defineProperty(state.gates, gate.operationId, {
        value: gate,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });
}

export async function* recorded(
  sessions: MutableStore<TheoremSessionState>,
  sessionId: string,
  events: AsyncIterable<TurnEvent>,
  context: OutcomeContext,
  seed: TurnEvent[] = [],
): AsyncGenerator<TurnEvent> {
  const seen: TurnEvent[] = [...seed];
  for await (const event of events) {
    seen.push(event);
    if (event.type === 'done' || event.type === 'provider_checkpoint')
      await recordOutcome(sessions, sessionId, seen, context);
    yield event;
  }
}

/** Save one credential, leaving the session's others as they are. */
function saveCredential(
  ctx: CallsContext,
  sessionId: string,
  slot: string,
  credential: TheoremCredentials[string],
): Promise<void> {
  return ctx.credentials.mutate(sessionId, (saved) => {
    saved[slot] = credential;
  });
}

/**
 * The session's credentials as a call reads them: one slot when a tool needs it,
 * saved the moment the kernel sets one, so a rotated refresh token is never lost
 * to a closed stream.
 */
export function sessionCredentials(ctx: CallsContext, sessionId: string): ToolCredentialSource {
  return {
    get: async (slot) => (await ctx.credentials.read(sessionId))[slot],
    set: (slot, credential) => saveCredential(ctx, sessionId, slot, credential),
    delete: (slot) =>
      ctx.credentials.mutate(sessionId, (saved) => {
        delete saved[slot];
      }),
  };
}

/** An OAuth gate given the host's sign-in URL. */
async function withAuthorizationUrl(
  ctx: CallsContext,
  at: CoreContext,
  event: TurnEvent,
): Promise<TurnEvent> {
  if (event.type !== 'tool' || event.tool.phase !== 'gate') return event;
  const { tool } = event;
  const gate = tool.gate.kind === 'auth' ? tool.gate : undefined;
  if (gate?.authChallenge.authType !== 'oauth2' || !ctx.options.authorizationUrl) return event;
  const challenge = gate.authChallenge;
  const authorizationUrl = await ctx.options.authorizationUrl(challenge, at);
  return {
    ...event,
    tool: { ...tool, gate: { ...gate, authChallenge: { ...challenge, authorizationUrl } } },
  };
}

/** Every OAuth gate in the stream, given the host's sign-in URL. */
export async function* withAuthorizationUrls(
  ctx: CallsContext,
  at: CoreContext,
  events: AsyncIterable<TurnEvent>,
): AsyncGenerator<TurnEvent> {
  for await (const event of events) yield await withAuthorizationUrl(ctx, at, event);
}

/** The session's paused call, answered and taken out: each answer settles it once, as the model asked it. */
type AnsweredCall = { callId: string; pending: PendingToolGate; answer: AnsweredGate };

function answerPendingGate(
  state: TheoremSessionState,
  request: GateAnswerRequest & GateReference,
  profileId: string,
): AnsweredCall {
  const operation = Object.hasOwn(state.operations, request.operationId)
    ? state.operations[request.operationId]
    : undefined;
  if (
    operation?.status === 'ready' &&
    operation.profileId === profileId &&
    operation.pending.callId === request.callId
  ) {
    const accepted = answerGatedCall(
      request,
      {
        name: operation.pending.name,
        arguments: operation.pending.arguments,
        permission: operation.pending.gate.permission,
        gateKind: operation.pending.gate.kind,
        ...(operation.pending.gate.kind === 'auth' && operation.pending.gate.auth
          ? { auth: operation.pending.gate.auth }
          : {}),
      },
      operation.answer.sessionPermissions,
    );
    const { typed: _typed, ...plain } = accepted;
    if (!sameAcceptedAnswer(plain, operation.answer))
      throw new TheoremError('request', labelText('error.request'));
    return {
      callId: request.callId,
      pending: operation.pending,
      answer: { ...operation.answer, ...(accepted.typed ? { typed: accepted.typed } : {}) },
    };
  }
  const pending = Object.hasOwn(state.gates, request.operationId)
    ? state.gates[request.operationId]
    : undefined;
  if (!pending || pending.profileId !== profileId || pending.callId !== request.callId) {
    throw new TheoremError('request', labelText('session.gate_expired'), {
      copy: { key: 'session.gate_expired' },
    });
  }
  // why: A refused answer (a refused secret, an edit without an approval) throws here and leaves the gate pending.
  const answer = answerGatedCall(
    request,
    {
      name: pending.name,
      arguments: pending.arguments,
      permission: pending.gate.permission,
      gateKind: pending.gate.kind,
      ...(pending.gate.kind === 'auth' && pending.gate.auth ? { auth: pending.gate.auth } : {}),
    },
    state.permissions,
  );
  delete state.gates[request.operationId];
  const { typed: _typed, ...accepted } = answer;
  state.operations[request.operationId] = {
    status: 'ready',
    profileId,
    pending,
    answer: accepted,
    readyAt: Date.now(),
  };
  state.permissions = answer.sessionPermissions;
  return { callId: request.callId, pending, answer };
}

/** A call a message walks away from: taken from its gate now, or settled by an earlier request its client never heard. */
type WalkedCall =
  | AnsweredCall
  | { callId: string; settled: Extract<SessionToolOperation, { status: 'settled' }> };

function walkedCallOf(
  state: TheoremSessionState,
  reference: GateReference,
  profileId: string,
  paused: TurnEvent[],
  cause: 'abandoned' | 'expired' = 'abandoned',
): WalkedCall {
  const settled = Object.hasOwn(state.operations, reference.operationId)
    ? state.operations[reference.operationId]
    : undefined;
  // why: A wake that took the call and ended before the call settled left it refused and not run; the next wake runs it with the answer it has.
  if (cause === 'expired' && settled && refusedAndNotRun(settled, reference, profileId)) {
    return { callId: reference.callId, pending: settled.pending, answer: settled.answer };
  }
  // why: A gate that lapsed is gone from the session while the reply still waits on its call. The call is only ever cancelled here, so the next message is never refused for it.
  if (!settled && !Object.hasOwn(state.gates, reference.operationId)) {
    const lapsed = pendingGatesFrom(paused, { profileId, turnInput: {} }).find(
      ({ callId }) => callId === reference.callId,
    );
    if (lapsed) state.gates[reference.operationId] = lapsed.gate;
  }
  if (
    settled?.status === 'settled' &&
    settled.callId === reference.callId &&
    settled.profileId === profileId
  ) {
    return { callId: reference.callId, settled };
  }
  const answered = answerPendingGate(state, { ...reference, decision: 'abandon' }, profileId);
  if (cause === 'abandoned') return answered;
  const answer = { ...answered.answer, resume: { ...answered.answer.resume, cause } };
  const taken = state.operations[reference.operationId];
  if (taken?.status === 'ready') taken.answer = answer;
  return { ...answered, answer };
}

type ReadyOperation = Extract<SessionToolOperation, { status: 'ready' }>;

/** Whether `operation` is this call, answered with a refusal and not yet run. */
function refusedAndNotRun(
  operation: SessionToolOperation,
  reference: GateReference,
  profileId: string,
): operation is ReadyOperation {
  return (
    operation.status === 'ready' &&
    operation.profileId === profileId &&
    operation.pending.callId === reference.callId &&
    operation.answer.resume.granted !== true
  );
}

/**
 * What a paused reply's calls still wait on, for a reply to no message. Defined while a call's
 * gate can be answered, or its answer runs; `until` is when the last gate lapses, unset when one
 * has no time limit or an answer runs. Undefined once every gate has lapsed, and for a
 * conversation that is not paused.
 */
function stillWaits(
  state: TheoremSessionState,
  calls: readonly GateReference[],
  profileId: string,
): { until?: number } | undefined {
  let waits = false;
  let until: number | undefined = 0;
  for (const reference of calls) {
    const gate = Object.hasOwn(state.gates, reference.operationId)
      ? state.gates[reference.operationId]
      : undefined;
    const operation = Object.hasOwn(state.operations, reference.operationId)
      ? state.operations[reference.operationId]
      : undefined;
    const runs =
      operation !== undefined &&
      operation.status !== 'settled' &&
      !refusedAndNotRun(operation, reference, profileId);
    if (!gate && !runs) continue;
    waits = true;
    until =
      gate?.expiresAt === undefined || until === undefined || runs
        ? undefined
        : Math.max(until, gate.expiresAt);
  }
  return waits ? (until === undefined ? {} : { until }) : undefined;
}

/** {@link stillWaits} for `conversation`'s paused reply, read from the session. Writes nothing. */
export async function pausedWaits(
  ctx: CallsContext,
  at: CoreContext,
  conversation: StoredConversation,
): Promise<{ until?: number } | undefined> {
  const calls = waitingCalls(conversation);
  if (!calls.length) return undefined;
  return stillWaits(await ctx.sessions.read(at.sessionId), calls, ctx.profile.id);
}

/**
 * Take the calls of a paused reply whose gates have all lapsed out of the session, each settled
 * as `expired`. Undefined, with nothing taken, while one still waits ({@link stillWaits}).
 */
export async function takeLapsed(
  ctx: CallsContext,
  at: CoreContext,
  conversation: StoredConversation,
): Promise<IssuedWalkAway[] | undefined> {
  const references = waitingCalls(conversation);
  const paused = conversation.paused?.events ?? [];
  // why: One write decides and takes, so an answer that lands meanwhile is never walked away from.
  const calls = await ctx.sessions.mutate(at.sessionId, (state) =>
    stillWaits(state, references, ctx.profile.id)
      ? undefined
      : references.map((reference) => ({
          reference,
          call: walkedCallOf(state, reference, ctx.profile.id, paused, 'expired'),
        })),
  );
  return calls?.map((taken) => issuedWalkAway(ctx, at, taken));
}

/** A taken call with the run that settles it. */
function issuedWalkAway(
  ctx: CallsContext,
  at: CoreContext,
  { reference, call }: { reference: GateReference; call: WalkedCall },
): IssuedWalkAway {
  return {
    ...reference,
    events:
      'settled' in call ? replayOperation(ctx, at, call.settled) : settleAnswered(ctx, at, call),
  };
}

/**
 * Take the calls a message or a rewind walks away from out of the session,
 * answered `abandon`: every one of them, or none when one is neither waiting
 * nor settled. Each comes back with the run that settles it.
 */
export async function takeWalkedAway(
  ctx: CallsContext,
  at: CoreContext,
  abandon: readonly GateReference[],
  conversation: StoredConversation,
): Promise<IssuedWalkAway[]> {
  const paused = conversation.paused?.events ?? [];
  // why: A throw leaves the session unsaved, so no call is taken unless all are.
  const calls = await ctx.sessions.mutate(at.sessionId, (state) =>
    abandon.map((reference) => ({
      reference,
      call: walkedCallOf(state, reference, ctx.profile.id, paused),
    })),
  );
  return calls.map((taken) => issuedWalkAway(ctx, at, taken));
}

async function* settleAnswered(
  ctx: CallsContext,
  at: CoreContext,
  answered: AnsweredCall,
): AsyncGenerator<TurnEvent> {
  yield* invokeAnswered(ctx, at, answered);
}

async function* invokeAnswered(
  ctx: CallsContext,
  at: CoreContext,
  { callId, pending, answer }: AnsweredCall,
): AsyncGenerator<TurnEvent> {
  const host = await at.host;
  // why: The held call goes on with what the application set for its turn: its context, stage handler and credentials.
  const prepared = await preparedTurn(
    ctx.options.prepare,
    {
      profile: ctx.profile.id,
      execution: sessionToolCoordinator(ctx.sessions, at.sessionId),
      ...backgroundWiring(ctx, at),
      input: pending.turnInput ?? {},
      host,
      signal: at.signal,
      answersHeldCall: true,
    },
    {
      credentials: sessionCredentials(ctx, at.sessionId),
      ...(ctx.options.onStage ? { onStage: ctx.options.onStage } : {}),
      announce: (service) => announced(ctx, at, service),
    },
  );
  if (isRefusal(prepared)) {
    // labels-exempt: builder config error; the user reads error.config
    throw new TheoremError(
      'config',
      '`prepare` refused a turn that has `answersHeldCall`: an answered call has no reply to refuse',
    );
  }
  if (answer.typed) {
    // invariant: a sealed source keeps every key where the run cannot read it, so a key typed
    // here would be saved and never sent; the person enters it where the keys are kept.
    if (prepared.credentials && isSealedSource(prepared.credentials)) {
      throw new TheoremError(
        'request',
        `call ${callId} runs with a sealed credential source, which takes no typed secret`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    await saveCredential(ctx, at.sessionId, answer.typed.slot, answer.typed.credential);
  }
  yield* invokeTool({
    profile: ctx.profile.id,
    ...(prepared.execution ? { execution: prepared.execution } : {}),
    ...(prepared.background ? { background: prepared.background } : {}),
    pageExecution: sessionPageDispatch(
      ctx.sessions,
      at.sessionId,
      ctx.pageToolBroker,
      ctx.options.pageToolTimeoutMs,
    ).execution,
    name: pending.name,
    callId,
    operationId: pending.operationId,
    input: answer.input,
    resume: answer.resume,
    // why: An approval that names no answer is the page saying it has none, so the call is not held again.
    ...(pending.gate.kind === 'page' && answer.resume.granted
      ? { page: answer.page ?? { unanswered: true } }
      : {}),
    sessionPermissions: answer.sessionPermissions,
    credentials: prepared.credentials,
    ...(prepared.onStage ? { onStage: prepared.onStage } : {}),
    turnInput: pending.turnInput,
    snapshot: pending.snapshot,
    promoted: pending.promoted,
    model: pending.model,
    signal: at.signal,
    host: prepared.host,
  });
}

/** The host's service for a call in this session, for a request that runs a tool. */
export function backgroundWiring(
  ctx: CallsContext,
  at: CoreContext,
): { background?: ToolBackgroundService } {
  const service = ctx.options.background?.(at);
  return service ? { background: announced(ctx, at, service) } : {};
}

/**
 * What became of the detached call, once it has ended; undefined while it runs, and when the
 * session holds no record of it, since an end it never saw is not one to save.
 */
function endedOutcome(
  ctx: CallsContext,
  call: DetachedCall,
  operations: TheoremSessionState['operations'],
): ToolOperationOutcome | undefined {
  const { operationId } = call;
  if (!Object.hasOwn(operations, operationId)) return undefined;
  return detachedEnd(call, operations[operationId], ctx.profile.labels);
}

/** Saves a detached call's end on its block. What the store throws is reported: the page then reads the end from the session. */
async function saveEnding(
  ctx: CallsContext,
  at: CoreContext,
  operationId: string,
  outcome: ToolOperationOutcome,
): Promise<void> {
  const { endings } = ctx;
  const tool = endings && readerEnding(outcome, endings.forReader);
  if (!endings || !tool) return;
  try {
    await endings.store.end(at.sessionId, { operationId, tool });
  } catch (err) {
    ctx.options.onError?.(err, at);
  }
}

/**
 * Saves the end of each call in `blocks` that detached and has ended already: a call that ended
 * before its reply was written had no block to take its end.
 */
export async function saveEnded(
  ctx: CallsContext,
  at: CoreContext,
  blocks: readonly TranscriptBlock[],
): Promise<void> {
  const calls = blocks.flatMap((block) => {
    if (block.kind !== 'tool' || block.tool.state?.phase !== 'background') return [];
    const { operationId, callId, name, state } = block.tool;
    return operationId ? [{ operationId, callId, name, at: state.at }] : [];
  });
  if (!ctx.endings || calls.length === 0) return;
  const { operations } = await ctx.sessions.read(at.sessionId);
  for (const call of calls) {
    const outcome = endedOutcome(ctx, call, operations);
    if (outcome) await saveEnding(ctx, at, call.operationId, outcome);
  }
}

/**
 * `service`, saving each of its calls' end on the call's block when it ends, then telling the
 * session's open pages, then the decider's `ended`, with the wake and the notify it may use.
 */
export function announced(
  ctx: CallsContext,
  at: CoreContext,
  service: ToolBackgroundService,
): ToolBackgroundService {
  const { notifier, lateResultsDecider } = ctx.options;
  const ended = lateResultsDecider?.ended?.bind(lateResultsDecider);
  if (!notifier && !ended && !ctx.endings) return service;
  const notify = async () => {
    await notifier?.publish(at.sessionId);
  };
  return {
    detached(call) {
      service.detached(call);
      void call.done
        .then(async () => {
          const { operationId, callId, toolId } = call;
          const outcome =
            ctx.endings || ended
              ? endedOutcome(
                  ctx,
                  { operationId, callId, name: toolId, at: Date.now() },
                  (await ctx.sessions.read(at.sessionId)).operations,
                )
              : undefined;
          if (outcome) await saveEnding(ctx, at, operationId, outcome);
          await notify();
          if (!ended || !outcome) return;
          await ended({
            host: await at.host,
            result: { operationId, outcome },
            wake: (conversation) => ctx.options.wake(at, conversation),
            notify,
          });
        })
        .catch((err: unknown) => ctx.options.onError?.(err, at));
    },
    event: (event, call) => service.event(event, call),
  };
}

/** A settled call's answer, streamed again. */
async function* once(event: TurnEvent, labels?: Profile['labels']): AsyncGenerator<TurnEvent> {
  yield withPublicLabels(event, labels);
}

/** Whether this request may read a settled call's result: the host's `authorizeToolReplay`. */
export async function replayAllowed(
  ctx: CallsContext,
  at: CoreContext,
  operation: Extract<SessionToolOperation, { status: 'settled' }>,
): Promise<boolean> {
  const { authorizeToolReplay } = ctx.options;
  return !authorizeToolReplay || (await authorizeToolReplay(at, operation));
}

async function* invokeEvents(
  ctx: CallsContext,
  at: CoreContext,
  answered: AnsweredCall,
): AsyncGenerator<TurnEvent> {
  const events = settleAnswered(ctx, at, answered);
  const { pending, answer } = answered;
  yield* recorded(
    ctx.sessions,
    at.sessionId,
    withAuthorizationUrls(ctx, at, events),
    {
      profileId: ctx.profile.id,
      turnInput: pending.turnInput,
      model: pending.model,
      promoted: pending.promoted,
    },
    [
      {
        type: 'tool',
        tool: {
          name: pending.name,
          callId: pending.callId,
          operationId: pending.operationId,
          arguments: jsonObjectSchema.parse(answer.input),
        },
      },
    ],
  );
}

/** One call of one of a host's tools, run as the page asked it; a gate it pauses on waits in the session. */
export async function* callEvents(
  ctx: CallsContext,
  at: CoreContext,
  body: TheoremHostCallRequest,
): AsyncGenerator<TurnEvent> {
  const state = await ctx.sessions.read(at.sessionId);
  const host = await at.host;
  const events = invokeTool({
    profile: ctx.profile.id,
    execution: sessionToolCoordinator(ctx.sessions, at.sessionId),
    ...backgroundWiring(ctx, at),
    pageExecution: sessionPageDispatch(
      ctx.sessions,
      at.sessionId,
      ctx.pageToolBroker,
      ctx.options.pageToolTimeoutMs,
    ).execution,
    name: body.name,
    input: body.input,
    sessionPermissions: state.permissions,
    credentials: sessionCredentials(ctx, at.sessionId),
    ...(ctx.options.onStage ? { onStage: ctx.options.onStage } : {}),
    signal: at.signal,
    host,
  });
  yield* recorded(ctx.sessions, at.sessionId, withAuthorizationUrls(ctx, at, events), {
    profileId: ctx.profile.id,
    turnInput: {},
  });
}

function answerRequest(body: TheoremInvokeRequest): GateAnswerRequest & GateReference {
  return {
    callId: body.gateId,
    operationId: body.operationId,
    decision: body.decision,
    input: body.input,
    secret: body.secret,
    page: body.page,
  };
}

async function* replayOperation(
  ctx: CallsContext,
  at: CoreContext,
  operation: Extract<SessionToolOperation, { status: 'settled' | 'background' }>,
): AsyncGenerator<TurnEvent> {
  const tool = defaultKernelScope.tools.get(operation.toolId);
  if (
    operation.profileId !== ctx.profile.id ||
    !tool ||
    tool.type === 'builtin' ||
    !('tools' in ctx.profile) ||
    !ctx.profile.tools?.allow.includes(operation.toolId) ||
    (operation.status === 'settled' &&
      ctx.options.authorizeToolReplay &&
      !(await ctx.options.authorizeToolReplay(at, operation)))
  )
    throw new TheoremError('blocked', labelText('error.blocked'));
  authorizeToolReplay({
    tools: defaultKernelScope.tools,
    profile: ctx.profile,
    name: operation.toolId,
    resume: undefined,
    ...(operation.status === 'settled' ? { outcome: operation.outcome } : {}),
  });
  yield* once(
    operation.status === 'settled' ? operation.outcome.event : operation.reply.event,
    ctx.profile.labels,
  );
}

/** The answered call's events: its saved outcome again, or the call run as answered. */
export async function settlingOf(
  ctx: CallsContext,
  at: CoreContext,
  body: TheoremInvokeRequest,
): Promise<() => AsyncIterable<TurnEvent>> {
  const saved = await ctx.sessions.read(at.sessionId);
  const operation = Object.hasOwn(saved.operations, body.operationId)
    ? saved.operations[body.operationId]
    : undefined;
  if (
    operation &&
    operation.status !== 'ready' &&
    operation.callId === body.gateId &&
    operation.profileId === ctx.profile.id &&
    (operation.status === 'running' || operation.status === 'uncertain')
  ) {
    throw new TheoremError(
      'conflict',
      `The tool operation is ${operation.status}, so it does not run again until the host settles it`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      { copy: { key: 'tool.execution_uncertain' } },
    );
  }
  if (
    (operation?.status === 'settled' || operation?.status === 'background') &&
    operation.profileId === ctx.profile.id &&
    operation.callId === body.gateId
  ) {
    if (
      body.input !== undefined &&
      (!operation.invocation ||
        (await toolInvocationHash(body.input)) !==
          (await toolInvocationHash(operation.invocation.accepted.input)))
    )
      throw new TheoremError('request', labelText('error.request'), {
        copy: { key: 'error.request' },
      });
    return () => replayOperation(ctx, at, operation);
  }
  // why: Take the answered call before streaming, so a stale answer is a reply status, not a stream error.
  const answered = await ctx.sessions.mutate(at.sessionId, (state) =>
    answerPendingGate(state, answerRequest(body), ctx.profile.id),
  );
  return () => invokeEvents(ctx, at, answered);
}
