import type { ProfileDefinition, TraceRecord, TurnEvent } from '../mod.ts';
import {
  labelText,
  registerTraceDestination,
  resolveObservabilityPolicy,
  TheoremError,
  z,
} from '../mod.ts';
import {
  type DecisionTransport,
  withFailedTraces,
} from '../react/src/client/decision-transport.ts';
import type { TheoremHostCallRequest } from '../react/src/client/host-transport.ts';
import type {
  ConversationView,
  TheoremConversationRequest,
  TheoremInvokeRequest,
  TheoremReplay,
  TheoremRewindRequest,
  TheoremRewound,
  TheoremTurnRequest,
} from '../react/src/client/transport.ts';
import type { TheoremConversationStore } from '../react/src/server/conversation-store.ts';
import {
  answerReply,
  type ConversationHost,
  conversationView,
  messageReply,
  type OpenedConversation,
  openConversation,
  postedInput,
  postedMessage,
  type ReplyLine,
  type ReplyRunner,
  readerConversationHost,
  requiredOperationId,
  requireRewindPoint,
  requireWaitingOn,
  requireWalkAway,
  rewindConversation,
  statelessRefusal,
  waitingCalls,
} from '../react/src/server/conversation.ts';
import { checkRequest } from '../react/src/server/request-check.ts';
import { type SteerInbox, steerStage } from '../react/src/server/steer-inbox.ts';
import {
  type ComposerProfileInterface,
  gatedToolsFromEvents,
  interfaceFromProfile,
  promotedToolIdsFromEvents,
  toolSnapshotFromEvents,
} from '../src/interface/mod.ts';
import type { RunDecisionOptions } from '../src/kernel/engine/decision.ts';
import type { GateAnswerRequest, GateReference } from '../src/kernel/mod.ts';
import {
  answerGatedCall,
  type HeldGatedCall,
  memoryCredentialSource,
  type RegisteredTool,
} from '../src/kernel/mod.ts';
import { STUDIO_TRACE_DESTINATION } from './policy.ts';
import { STUDIO_READER } from './reader.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import type { StudioRunPayload } from './run-payload.ts';
import {
  agentCallHook,
  type StudioDependency,
  type StudioRuntime,
  studioScope,
  runtimeProvider,
} from './runtime-scope.ts';
import { createStudioTraceRouter, type StudioTraceLine } from './traces.ts';
import type { StudioSteerLine } from './transport.ts';

// Profiles that write to the studio destination get their records back on the run's own stream.
export const studioTraces = createStudioTraceRouter();
registerTraceDestination(STUDIO_TRACE_DESTINATION, studioTraces.sink);

/**
 * Streams one run's lines, then the trace records it wrote. The kernel writes
 * a run's records before the run returns or throws, so a failed run still
 * delivers them ahead of its failure.
 */
async function* withRunTraces<Line>(
  run: (metadata: Record<string, string>) => AsyncIterable<Line>,
): AsyncGenerator<Line | StudioTraceLine> {
  const records: TraceRecord[] = [];
  const traces = studioTraces.route((record) => records.push(record));
  let failure: { error: unknown } | undefined;
  try {
    yield* run(traces.metadata);
  } catch (error) {
    failure = { error };
  } finally {
    traces.close();
  }
  for (const record of records) yield { type: 'trace', record };
  if (failure) throw failure.error;
}

function assertNotLiveProfile(profileType: string, action: string): void {
  if (profileType === 'live') {
    throw new TheoremError('request', `Studio ${action} does not support live profiles.`);
  }
}

/** A compiled draft as a run takes it. */
type StudioDraftRun = {
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
  structured?: StructuredRegistration;
  runtime: StudioRuntime;
  /** The agents this one names, registered before it. */
  dependencies?: StudioDependency[];
};

/** Where a chat's conversation is kept: the store, and the session its refs open in. */
export type StudioConversations = { sessionId: string; store: TheoremConversationStore };

type StudioScope = Awaited<ReturnType<typeof studioScope>>['scope'];
type StudioProfile = Awaited<ReturnType<typeof studioScope>>['profile'];

/** The draft's scope and its chat: the conversation host, or none for a stateless profile. */
async function studioChat(draft: StudioDraftRun, conversations: StudioConversations) {
  const { scope, profile } = await studioScope(
    draft.profile,
    draft.customTools,
    draft.structured,
    draft.runtime,
    draft.dependencies,
  );
  assertNotLiveProfile(profile.type, 'turn runner — use runSession');
  const iface = interfaceFromProfile(profile, scope.tools);
  const host =
    iface.providerContinuation?.history === 'stateless'
      ? undefined
      : readerConversationHost({
          ...conversations,
          profile,
          clientEvents: STUDIO_READER,
        });
  return { scope, profile, iface, host };
}

/** How a chat request runs the model for a reply, on the draft's scope. */
function studioRunner(args: {
  scope: StudioScope;
  profile: StudioProfile;
  runtime: StudioRuntime;
  metadata: Record<string, string>;
  sessionPermissions: string[] | undefined;
  model?: string;
  effort?: string;
  signal: AbortSignal;
  onStage?: ReturnType<typeof steerStage>;
}): ReplyRunner {
  const { scope, profile, runtime, metadata, signal } = args;
  return {
    run: (turn) =>
      scope.runTurn(
        {
          profile: profile.id,
          execution: runtime.execution,
          pageExecution: runtime.pageExecution,
          metadata,
          input: turn.input,
          providerState: turn.providerState,
          sessionPermissions: args.sessionPermissions,
          resolveHost: runtime.resolveHost,
          signal,
          ...(turn.model ? { model: turn.model } : {}),
          ...(turn.effort ? { effort: turn.effort } : {}),
          ...(args.onStage ? { onStage: args.onStage } : {}),
          onAgentCall: agentCallHook(scope, runtime),
        },
        runtimeProvider(runtime, scope, profile, turn.model),
      ),
    async compact(history, tokens, model) {
      const compacted = await scope.compactHistory(
        { profile: profile.id, history, tokens, signal, ...(model ? { model } : {}) },
        runtimeProvider(runtime, scope, profile, model),
      );
      return compacted?.history;
    },
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    signal,
  };
}

/**
 * The paused call as the stored reply holds it, answered. The studio keeps no
 * session, so the call's gate comes from the draft's registered tool; only the
 * permissions the page granted come from the browser.
 */
function answerPaused(
  scope: StudioScope,
  profile: string,
  opened: OpenedConversation,
  request: GateAnswerRequest & GateReference,
  sessionPermissions: string[] | undefined,
  runtime: StudioRuntime,
) {
  requireWaitingOn(opened.conversation, request);
  const events = opened.conversation.paused?.events ?? [];
  const call = gatedToolsFromEvents(events).find(
    (gated) => gated.callId === request.callId && gated.operationId === request.operationId,
  );
  // labels-exempt: internal diagnostic; the user reads error.internal
  if (!call) throw new TheoremError('internal', `the paused reply holds no call ${request.callId}`);
  return answerReplayed(
    scope,
    profile,
    request,
    {
      name: call.name,
      input: call.arguments,
      gateKind: call.gateKind,
      snapshot: toolSnapshotFromEvents(events),
      promoted: promotedToolIdsFromEvents(events),
      ...(opened.conversation.paused?.model ? { model: opened.conversation.paused.model } : {}),
      ...(sessionPermissions ? { sessionPermissions } : {}),
    },
    runtime,
  );
}

/**
 * One message, run against the conversation the host keeps: the paused calls it
 * walks away from settle first, then the reply runs.
 */
export async function* streamStudioTurn(
  args: StudioDraftRun & {
    request: TheoremTurnRequest;
    conversations: StudioConversations;
    signal: AbortSignal;
    /** Where the turn's mid-turn steers queue. */
    steer: SteerInbox;
  },
): AsyncGenerator<ReplyLine | StudioTraceLine | StudioSteerLine> {
  const { request, runtime, signal } = args;
  const { scope, profile, iface, host } = await studioChat(args, args.conversations);
  const message = postedMessage(iface, request.input);
  const input = postedInput(request.input, message);
  const sessionPermissions = request.replay?.sessionPermissions;
  if (!host && request.conversation !== undefined) throw statelessRefusal('continue');
  if (!host && request.abandon) throw statelessRefusal('walk away from');
  const opened = host ? await openConversation(host, request.conversation) : undefined;
  if (opened) requireWalkAway(opened.conversation, request.abandon);
  // Answered up front, so a refused call starts nothing.
  const walked = opened
    ? (request.abandon ?? []).map((reference) => ({
        reference,
        invoke: answerPaused(
          scope,
          profile.id,
          opened,
          { ...reference, decision: 'abandon' },
          sessionPermissions,
          runtime,
        ),
      }))
    : [];

  // Random and picked here, so only the run's own browser can steer it.
  const inbox = globalThis.crypto.randomUUID();
  await args.steer.open(inbox);
  const steerLine: StudioSteerLine = { type: 'steer_inbox', inbox };
  yield steerLine;
  try {
    yield* withRunTraces((metadata): AsyncIterable<ReplyLine> => {
      const runner = studioRunner({
        scope,
        profile,
        runtime,
        metadata,
        sessionPermissions,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        signal,
        onStage: steerStage(args.steer, inbox),
      });
      if (!host || !opened) {
        return runner.run({ input, model: request.model, effort: request.effort });
      }
      const walkAway = walked.map(({ reference, invoke }) => ({
        ...reference,
        events: scope.invokeTool({ ...invoke, metadata, signal }),
      }));
      return messageReply({ host, opened, message, input, walkAway, runner });
    });
  } finally {
    await args.steer.close(inbox);
  }
}

/** The model's input to the paused call, as the browser replays it. */
const modelArguments = z.record(z.string(), z.unknown());

/** The gate a tool waits on: its permission tier, and the slot a sign-in gate fills. */
function heldGate(tool: RegisteredTool): Pick<HeldGatedCall, 'permission' | 'auth'> {
  const auth = 'auth' in tool ? tool.auth : undefined;
  return {
    permission: tool.permission,
    ...(auth
      ? {
          auth: { slot: auth.slot, authType: auth.type, service: auth.service },
        }
      : {}),
  };
}

/**
 * The user's answer to a paused call, as `replay` holds it. The studio keeps no
 * session; its gate comes from the draft's registered tool, and the answer
 * settles it by the rule every Theorem host uses. Returns the run that settles
 * it, less its trace metadata.
 */
function answerReplayed(
  scope: StudioScope,
  profile: string,
  request: GateAnswerRequest & { operationId: string },
  replay: TheoremReplay,
  runtime: StudioRuntime,
): Omit<Parameters<StudioScope['invokeTool']>[0], 'metadata'> {
  const tool = replay.name === undefined ? undefined : scope.tools.get(replay.name);
  if (!tool) {
    // labels-exempt: internal diagnostic; the user reads error.request
    throw new TheoremError('request', 'invoke: the paused call names no tool in this draft');
  }
  const answered = answerGatedCall(
    request,
    {
      name: tool.name,
      arguments: checkRequest(modelArguments, replay.input, 'replayed call input'),
      gateKind: replay.gateKind,
      ...heldGate(tool),
    },
    replay.sessionPermissions ?? [],
  );
  return {
    profile,
    name: tool.name,
    callId: request.callId,
    operationId: request.operationId,
    input: answered.input,
    resume: answered.resume,
    ...(answered.page ? { page: answered.page } : {}),
    sessionPermissions: answered.sessionPermissions,
    ...(answered.typed
      ? {
          credentials: memoryCredentialSource({
            [answered.typed.slot]: answered.typed.credential,
          }),
        }
      : {}),
    snapshot: replay.snapshot,
    promoted: replay.promoted,
    model: replay.model,
    resolveHost: runtime.resolveHost,
    execution: runtime.execution,
    pageExecution: runtime.pageExecution,
    onAgentCall: agentCallHook(scope, runtime),
  };
}

function answerOf(answer: TheoremInvokeRequest): GateAnswerRequest & GateReference {
  const { gateId, operationId, decision, input, secret, page } = answer;
  return { callId: gateId, operationId, decision, input, secret, page };
}

/** A paused call the browser replays, answered: a host draft's call, or a stateless chat's. */
function replayedInvoke(
  scope: StudioScope,
  profile: string,
  answer: TheoremInvokeRequest,
  runtime: StudioRuntime,
  signal: AbortSignal,
): AsyncIterable<TurnEvent | StudioTraceLine> {
  const invoke = answerReplayed(scope, profile, answerOf(answer), answer.replay ?? {}, runtime);
  return withRunTraces((metadata) => scope.invokeTool({ ...invoke, metadata, signal }));
}

/**
 * The user's answer to a paused call. In a kept conversation the reply goes on
 * in the same stream once no call waits; otherwise the stream is the call's.
 */
export async function* streamStudioInvoke(
  args: StudioDraftRun & {
    answer: TheoremInvokeRequest;
    conversations: StudioConversations;
    signal: AbortSignal;
  },
): AsyncGenerator<ReplyLine | StudioTraceLine> {
  const { answer, runtime, signal } = args;
  const { scope, profile, host } = await studioChat(args, args.conversations);
  const request = answerOf(answer);
  const sessionPermissions = answer.replay?.sessionPermissions;
  if (!host) {
    if (answer.conversation !== undefined) throw statelessRefusal('continue');
    yield* replayedInvoke(scope, profile.id, answer, runtime, signal);
    return;
  }
  if (answer.conversation === undefined) throw statelessRefusal('continue');
  const opened = await openConversation(host, answer.conversation);
  requireWaitingOn(opened.conversation, request);
  const invoke = answerPaused(scope, profile.id, opened, request, sessionPermissions, runtime);
  yield* withRunTraces((metadata) =>
    answerReply({
      host,
      opened,
      call: { callId: request.callId, operationId: request.operationId },
      settling: scope.invokeTool({ ...invoke, metadata, signal }),
      runner: studioRunner({
        scope,
        profile,
        runtime,
        metadata,
        sessionPermissions,
        signal,
      }),
    }),
  );
}

/** The conversation under a ref, as the page draws it. */
export async function studioConversation(
  draft: StudioDraftRun,
  conversations: StudioConversations,
  request: TheoremConversationRequest,
): Promise<ConversationView> {
  const { host } = await studioChat(draft, conversations);
  if (!host) throw statelessRefusal('read');
  const opened = await openConversation(host, request.conversation);
  return conversationView(host, opened.conversation);
}

/** The conversation cut after one block; a reply that waits on gates is walked away from first. */
export async function rewindStudio(
  draft: StudioDraftRun,
  conversations: StudioConversations,
  request: TheoremRewindRequest,
  signal: AbortSignal,
): Promise<TheoremRewound> {
  const { scope, profile, host } = await studioChat(draft, conversations);
  if (!host) throw statelessRefusal('rewind');
  const opened = await openConversation(host, request.conversation);
  requireRewindPoint(opened.conversation, request.at);
  const walkAway = waitingCalls(opened.conversation).map((call) => {
    const reference = { callId: call.callId, operationId: requiredOperationId(call) };
    const invoke = answerPaused(
      scope,
      profile.id,
      opened,
      { ...reference, decision: 'abandon' },
      undefined,
      draft.runtime,
    );
    return { ...reference, events: scope.invokeTool({ ...invoke, signal }) };
  });
  const next = await rewindConversation({ host, opened, at: request.at, walkAway });
  if (next.ref === null) throw new TheoremError('internal', labelText('error.internal'));
  return { conversation: next.ref, view: conversationView(host, next.conversation) };
}

/** The user's answer to a host draft's paused call: the studio keeps no session, so the browser replays it. */
export async function* streamStudioHostInvoke(
  args: StudioDraftRun & { answer: TheoremInvokeRequest; signal: AbortSignal },
): AsyncGenerator<TurnEvent | StudioTraceLine> {
  const { scope, profile } = await hostScope(args);
  yield* replayedInvoke(scope, profile.id, args.answer, args.runtime, args.signal);
}

/** A host draft's scope; any other profile is refused. */
async function hostScope(draft: Omit<StudioDraftRun, 'structured'>) {
  const opened = await studioScope(
    draft.profile,
    draft.customTools,
    undefined,
    draft.runtime,
    draft.dependencies,
  );
  if (opened.profile.type !== 'host') {
    // labels-exempt: internal diagnostic; the user reads error.request
    throw new TheoremError('request', 'Studio calls run host profiles only.');
  }
  return opened;
}

/** One call of a host draft's tool, streamed. */
export async function* streamStudioCall(args: {
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
  call: TheoremHostCallRequest;
  /** Tools the user allowed for the page; the studio keeps no session. */
  sessionPermissions?: string[];
  signal?: AbortSignal;
  runtime: StudioRuntime;
  dependencies?: StudioDependency[];
}): AsyncGenerator<TurnEvent | StudioTraceLine> {
  const { scope, profile } = await hostScope(args);
  yield* withRunTraces((metadata) =>
    scope.invokeTool({
      profile: profile.id,
      execution: args.runtime.execution,
      pageExecution: args.runtime.pageExecution,
      name: args.call.name,
      input: args.call.input,
      sessionPermissions: args.sessionPermissions,
      resolveHost: args.runtime.resolveHost,
      onAgentCall: agentCallHook(scope, args.runtime),
      signal: args.signal,
      metadata,
    }),
  );
}

export { type StudioDependency, type StudioRuntime, studioScope } from './runtime-scope.ts';

/** Both hosts run decisions through the kernel; the browser supplies its provider vault. */
export async function runStudioDecision(
  payload: StudioRunPayload,
  state: Parameters<DecisionTransport['decide']>[0],
  options: RunDecisionOptions,
  signal?: AbortSignal,
) {
  const { scope, profile } = await studioScope(payload.profile, [], undefined, {
    mode: 'byok',
  });
  const traces: TraceRecord[] = [];
  const records = profile.observability
    ? resolveObservabilityPolicy(profile.observability).record
    : false;
  const sink = {
    write: (record: TraceRecord) => {
      traces.push(record);
      return Promise.resolve();
    },
  };
  try {
    const result = await scope.runDecision(
      { profile: profile.id, state, questions: payload.questions ?? {}, signal },
      { ...options, ...(records ? { sink } : {}) },
    );
    return { result, traces };
  } catch (err) {
    // The kernel traces a decision however it ends; the failure carries what it left.
    throw withFailedTraces(err, traces);
  }
}

export { failedDecisionTraces, withFailedTraces } from '../react/src/client/decision-transport.ts';

export { studioKeySlots } from './browser-connection.ts';
