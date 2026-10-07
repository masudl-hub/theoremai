import type { ProfileDefinition, TraceRecord, TurnEvent } from '../mod.ts';
import {
  registerTraceDestination,
  resolveObservabilityPolicy,
  TheoremError,
  z,
} from '../mod.ts';
import type { DecisionTransport } from '../react/src/client/decision-transport.ts';
import type { TheoremHostCallRequest } from '../react/src/client/host-transport.ts';
import type {
  TheoremInvokeRequest,
  TheoremReplay,
  TheoremTurnInput,
} from '../react/src/client/transport.ts';
import { checkRequest } from '../react/src/server/request-check.ts';
import { type SteerInbox, steerStage } from '../react/src/server/steer-inbox.ts';
import { kernelTurnInput } from '../react/src/server/turn-input.ts';
import { checkWalkAway, type WalkedAwayCall, walkAway } from '../react/src/server/walk-away.ts';
import type { RunDecisionOptions } from '../src/kernel/engine/decision.ts';
import type { GateAnswerRequest } from '../src/kernel/mod.ts';
import {
  answerGatedCall,
  type HeldGatedCall,
  memoryCredentialSource,
  type RegisteredTool,
} from '../src/kernel/mod.ts';
import { PLAYGROUND_TRACE_DESTINATION } from './policy.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import {
  agentCallHook,
  type PlaygroundDependency,
  type PlaygroundRuntime,
  playgroundScope,
  runtimeProvider,
} from './runtime-scope.ts';
import { createPlaygroundTraceRouter, type PlaygroundTraceLine } from './traces.ts';
import type { PlaygroundSteerLine } from './transport.ts';

// Profiles that write to the playground destination get their records back on the run's own stream.
export const playgroundTraces = createPlaygroundTraceRouter();
registerTraceDestination(PLAYGROUND_TRACE_DESTINATION, playgroundTraces.sink);

/**
 * Streams one run's events, then the trace records it wrote. The kernel writes
 * a run's records before the run returns or throws, so a failed run still
 * delivers them ahead of its failure.
 */
async function* withRunTraces(
  run: (metadata: Record<string, string>) => AsyncIterable<TurnEvent>,
): AsyncGenerator<TurnEvent | PlaygroundTraceLine> {
  const records: TraceRecord[] = [];
  const traces = playgroundTraces.route((record) => records.push(record));
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
    throw new TheoremError('request', `Playground ${action} does not support live profiles.`);
  }
}

export async function* streamPlaygroundTurn(args: {
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
  structured?: StructuredRegistration;
  /** The turn as the browser sent it; its context is read as the client's. */
  input: TheoremTurnInput;
  previousInteractionId?: string;
  sessionPermissions?: string[];
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  runtime: PlaygroundRuntime;
  /** The agents this one names, registered before it. */
  dependencies?: PlaygroundDependency[];
  /** Where the turn's mid-turn steers queue. */
  steer: SteerInbox;
  /** The paused calls the message walks away from, each as the browser replays it. */
  abandon?: { callId: string; replay: TheoremReplay }[];
}): AsyncGenerator<TurnEvent | PlaygroundTraceLine | PlaygroundSteerLine> {
  const { scope, profile } = await playgroundScope(
    args.profile,
    args.customTools,
    args.structured,
    args.runtime,
    args.dependencies,
  );
  assertNotLiveProfile(profile.type, 'turn runner — use runSession');
  const sent = kernelTurnInput(args.input);
  const abandon = args.abandon ?? [];
  if (abandon.length) {
    checkWalkAway(
      sent,
      abandon.map(({ callId }) => callId),
    );
  }
  // Answered up front, so a refused call starts nothing.
  const walked = abandon.map(({ callId, replay }) => ({
    callId,
    invoke: answerReplayed(
      scope,
      profile.id,
      { callId, decision: 'abandon' },
      replay,
      args.runtime,
    ),
  }));

  const provider = runtimeProvider(args.runtime, profile, args.model);
  // Random and picked here, so only the run's own browser can steer it.
  const inbox = globalThis.crypto.randomUUID();
  await args.steer.open(inbox);
  const steerLine: PlaygroundSteerLine = { type: 'steer_inbox', inbox };
  yield steerLine;

  try {
    yield* withRunTraces(async function* (metadata) {
      const calls: WalkedAwayCall[] = walked.map(({ callId, invoke }) => ({
        callId,
        events: scope.invokeTool({ ...invoke, metadata, signal: args.signal }),
      }));
      const input = calls.length ? yield* walkAway(sent, calls) : sent;
      if (!input) return;
      yield* scope.runTurn(
        {
          profile: profile.id,
          metadata,
          input,
          previousInteractionId: args.previousInteractionId,
          sessionPermissions: args.sessionPermissions,
          resolveHost: args.runtime.resolveHost,
          signal: args.signal,
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          onStage: steerStage(args.steer, inbox),
          onAgentCall: agentCallHook(scope, args.runtime),
        },
        provider,
      );
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

type PlaygroundScope = Awaited<ReturnType<typeof playgroundScope>>['scope'];

/**
 * The user's answer to a paused call. The playground keeps no session, so the
 * browser replays the call; its gate comes from the draft's registered tool,
 * and the answer settles it by the rule every Theorem host uses. Returns the
 * run that settles it, less its trace metadata.
 */
function answerReplayed(
  scope: PlaygroundScope,
  profile: string,
  request: GateAnswerRequest,
  replay: TheoremReplay,
  runtime: PlaygroundRuntime,
): Omit<Parameters<PlaygroundScope['invokeTool']>[0], 'metadata'> {
  const tool = replay.name === undefined ? undefined : scope.tools.get(replay.name);
  if (!tool) {
    // lexicon-exempt: internal diagnostic; the user reads error.request
    throw new TheoremError('request', 'invoke: the paused call names no tool in this draft');
  }
  const answered = answerGatedCall(
    request,
    {
      name: tool.name,
      arguments: checkRequest(modelArguments, replay.input, 'replayed call input'),
      ...heldGate(tool),
    },
    replay.sessionPermissions ?? [],
  );
  return {
    profile,
    name: tool.name,
    callId: request.callId,
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
    turnInput: replay.turnInput && kernelTurnInput(replay.turnInput),
    snapshot: replay.snapshot,
    promoted: replay.promoted,
    model: replay.model,
    path: replay.path,
    resolveHost: runtime.resolveHost,
    onAgentCall: agentCallHook(scope, runtime),
  };
}

/** The user's answer to a paused call, streamed. */
export async function* streamPlaygroundInvoke(args: {
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
  structured?: StructuredRegistration;
  answer: TheoremInvokeRequest;
  signal?: AbortSignal;
  runtime: PlaygroundRuntime;
  dependencies?: PlaygroundDependency[];
}): AsyncGenerator<TurnEvent | PlaygroundTraceLine> {
  const { scope, profile } = await playgroundScope(
    args.profile,
    args.customTools,
    args.structured,
    args.runtime,
    args.dependencies,
  );
  assertNotLiveProfile(profile.type, 'invoke');
  const { gateId, decision, input, secret, page, replay = {} } = args.answer;
  const invoke = answerReplayed(
    scope,
    profile.id,
    { callId: gateId, decision, input, secret, page },
    replay,
    args.runtime,
  );
  yield* withRunTraces((metadata) =>
    scope.invokeTool({ ...invoke, metadata, signal: args.signal }),
  );
}

/** One call of a host draft's tool, streamed. */
export async function* streamPlaygroundCall(args: {
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
  call: TheoremHostCallRequest;
  /** Tools the user allowed for the page; the playground keeps no session. */
  sessionPermissions?: string[];
  signal?: AbortSignal;
  runtime: PlaygroundRuntime;
  dependencies?: PlaygroundDependency[];
}): AsyncGenerator<TurnEvent | PlaygroundTraceLine> {
  const { scope, profile } = await playgroundScope(
    args.profile,
    args.customTools,
    undefined,
    args.runtime,
    args.dependencies,
  );
  if (profile.type !== 'host') {
    // lexicon-exempt: internal diagnostic; the user reads error.request
    throw new TheoremError('request', 'Playground calls run host profiles only.');
  }
  yield* withRunTraces((metadata) =>
    scope.invokeTool({
      profile: profile.id,
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

export { type PlaygroundDependency, type PlaygroundRuntime, playgroundScope } from './runtime-scope.ts';

/** Both hosts run decisions through the kernel; the browser supplies its provider vault. */
export async function runPlaygroundDecision(
  payload: PlaygroundRunPayload,
  state: Parameters<DecisionTransport['decide']>[0],
  options: RunDecisionOptions,
  signal?: AbortSignal,
) {
  const { scope, profile } = await playgroundScope(payload.profile, [], undefined, {
    mode: 'byok',
  });
  const traces: TraceRecord[] = [];
  const records = profile.observability
    ? resolveObservabilityPolicy(profile.observability).record
    : false;
  const result = await scope.runDecision(
    {
      profile: profile.id,
      state,
      questions: payload.questions ?? {},
      signal,
    },
    {
      ...options,
      ...(records
        ? {
            sink: {
              write: (record: TraceRecord) => {
                traces.push(record);
                return Promise.resolve();
              },
            },
          }
        : {}),
    },
  );
  return { result, traces };
}

export { playgroundKeySlots } from './browser-connection.ts';
