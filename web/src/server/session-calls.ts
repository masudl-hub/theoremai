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
  type StageHandler,
  TheoremError,
  type ToolGate,
  type TurnEvent,
  type TurnInput,
  type TurnWiring,
  toolInvocationHash,
} from '@theoremjs/agents';
import { withPublicLabels } from '@theoremjs/agents/guardrails';
import {
  gatedToolsFromEvents,
  promotedToolIdsFromEvents,
  toolSnapshotFromEvents,
} from '@theoremjs/agents/interface';
import {
  type AnsweredGate,
  answerGatedCall,
  type GateAnswerRequest,
  isSealedSource,
  type ToolBackgroundService,
  type ToolCredentialSource,
} from '@theoremjs/agents/kernel';
import type { TheoremHostCallRequest } from '../client/host-transport.ts';
import type { TheoremInvokeRequest } from '../client/transport.ts';
import { type IssuedWalkAway, requiredOperationId } from './conversation.ts';
import { detachedEnd, type SettledOperation } from './conversation-inbox.ts';
import type { StoredConversation } from './conversation-store.ts';
import type { TheoremCredentials } from './credential-store.ts';
import type { TheoremNotifier } from './notifier.ts';
import { type PageToolBroker, sessionPageDispatch } from './page-dispatch.ts';
import type { MutableStore, SessionStateStore } from './session-authority.ts';
import type {
  PendingToolGate,
  SessionToolOperation,
  TheoremSessionState,
} from './session-store.ts';
import { sameAcceptedAnswer, sessionToolCoordinator } from './tool-operations.ts';
import { preparedTurn } from './turn-wiring.ts';

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
export type CallsContext = {
  profile: Profile;
  sessions: SessionStateStore;
  credentials: MutableStore<TheoremCredentials>;
  pageToolBroker: PageToolBroker;
  options: {
    prepare?: TurnWiring['prepare'];
    onStage?: StageHandler;
    pageToolTimeoutMs?: number;
    background?: (at: CoreContext) => ToolBackgroundService;
    notifier?: TheoremNotifier;
    lateResultsDecider?: TurnWiring['lateResultsDecider'];
    authorizeToolReplay?: (
      at: CoreContext,
      operation: SettledOperation,
    ) => boolean | Promise<boolean>;
    authorizationUrl?: (
      challenge: Extract<ToolGate, { kind: 'auth' }>['authChallenge'],
      at: CoreContext,
    ) => string | Promise<string>;
    onError?: (err: unknown, at: CoreContext) => void;
    /** The decider's wake, with no page: a reply to no message on a run of its own. */
    wake: (at: CoreContext, ref: string) => Promise<void>;
  };
};

type OutcomeContext = {
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
): WalkedCall {
  const settled = Object.hasOwn(state.operations, reference.operationId)
    ? state.operations[reference.operationId]
    : undefined;
  // why: A gate that lapsed is gone from the session while the reply still waits on its call. The call is only ever cancelled here, so the next message is never refused for it.
  if (!settled && !Object.hasOwn(state.gates, reference.operationId)) {
    const lapsed = pendingGatesFrom(paused, { profileId, turnInput: {} }).find(
      ({ callId }) => callId === reference.callId,
    );
    if (lapsed) state.gates[reference.operationId] = lapsed.gate;
  }
  return settled?.status === 'settled' &&
    settled.callId === reference.callId &&
    settled.profileId === profileId
    ? { callId: reference.callId, settled }
    : answerPendingGate(state, { ...reference, decision: 'abandon' }, profileId);
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
  return calls.map(({ reference, call }) => ({
    ...reference,
    events:
      'settled' in call ? replayOperation(ctx, at, call.settled) : settleAnswered(ctx, at, call),
  }));
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
 * `service`, telling the session's open pages when each of its calls ends, and the decider's
 * `ended`, with the wake and the notify it may use.
 */
export function announced(
  ctx: CallsContext,
  at: CoreContext,
  service: ToolBackgroundService,
): ToolBackgroundService {
  const { notifier, lateResultsDecider } = ctx.options;
  const ended = lateResultsDecider?.ended?.bind(lateResultsDecider);
  if (!notifier && !ended) return service;
  const notify = async () => {
    await notifier?.publish(at.sessionId);
  };
  return {
    detached(call) {
      service.detached(call);
      void call.done
        .then(async () => {
          await notify();
          if (!ended) return;
          const { operations } = await ctx.sessions.read(at.sessionId);
          const { operationId, callId, toolId } = call;
          const operation = Object.hasOwn(operations, operationId)
            ? operations[operationId]
            : undefined;
          const outcome = detachedEnd(
            { operationId, callId, name: toolId, at: Date.now() },
            operation,
            ctx.profile.labels,
          );
          if (!outcome) return;
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
