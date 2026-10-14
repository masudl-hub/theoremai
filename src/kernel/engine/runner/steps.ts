import { requestGivesCanary } from '../../../guardrails/canary.ts';
import { addRequestDestinations, addResultDestinations } from '../../../guardrails/destinations.ts';
import { TURN_REPLY } from '../../../guardrails/detect-reply.ts';
import { addRequestUrls } from '../../../guardrails/egress-urls.ts';
import { isAbortError, throwIfAborted } from '../../../guardrails/error.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { replyIsJudged } from '../../../guardrails/progressive-yield.ts';
import type { ErrorKind } from '../../../guardrails/theorem-error.ts';
import { recordTaint } from '../../../guardrails/tool-result.ts';
import type { TraceAttributes } from '../../../observability/trace-span.ts';
import { waitDefault } from '../../../providers/shared/retry.ts';
import { historyToolCalls } from '../../interaction-parts.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import { injectWouldExceedMaxSteps } from '../../stages.ts';
import {
  AUTO_CONTINUE_DELAY_MS,
  isFailedStopKind,
  profileAllowsInject,
  profileTurnResumption,
  shouldAutoContinue,
  stageAbortStop,
} from '../../stop.ts';
import type { BoundSystem } from '../../system-parts.ts';
import {
  failedActivity,
  failureEvent,
  type ToolCallBase,
  toolCallRequestEvent,
} from '../../tools/events.ts';
import type { ToolExecuteSettlement } from '../../tools/execute.ts';
import {
  executeRegisteredTool,
  shownToolArguments,
  type ToolStageSupport,
} from '../../tools/execute.ts';
import { formatToolFailureForModel, formatToolResult } from '../../tools/model-text.ts';
import type { ModelToolResult, ToolCallEvent, ToolFailure } from '../../tools/types.ts';
import type {
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnEventOf,
  TurnHistoryMessage,
  TurnRequest,
  TurnStop,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import { startToolTrace } from '../tool-trace.ts';
import { startCallTrace } from '../turn-trace.ts';
import { applyStageInjects } from './stages.ts';
import { recordStepEvent, type StepExecutionState } from './state.ts';
import { isWithheldOnBlock, type OutboundStreamControl, yieldProviderEvents } from './stream.ts';
import { callTokensEvent, observeCallEvent, startCallUsage } from './usage.ts';

function isStepLimitReached(step: number, maxSteps: number): boolean {
  return maxSteps > 0 && step >= maxSteps;
}

/** The step's generation: the turn's history so far, and no tools when the step must answer. */
function generationForProviderStep(
  generation: ResolvedGeneration,
  state: StepExecutionState,
  answerOnly: boolean,
): ResolvedGeneration {
  const forStep = { ...generation, history: state.currentHistory };
  if (!answerOnly) return forStep;
  return { ...forStep, builtins: [], tools: { ...generation.tools, wire: [] } };
}

/** True on the last step `maxSteps` allows, for a profile whose `atStepLimit` is `'answer'`. */
function isAnswerOnlyStep(profile: Profile, generation: ResolvedGeneration, step: number): boolean {
  return (
    profile.type === 'text' &&
    profile.turnBehaviour?.atStepLimit === 'answer' &&
    isStepLimitReached(step, generation.maxSteps ?? 0)
  );
}

/**
 * A call the model made in one step: its raw call, which owns the arguments,
 * and the failure a provider pairs with a malformed one (the model reads that
 * back instead of the tool running).
 */
interface ModelCall extends ToolCallBase {
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  failure?: ToolFailure;
}

/**
 * Hold the model's calls until its stream ends: a raw call, and a provider's
 * failure for a call it already sent. Returns false for any other tool event.
 */
function holdModelCall(calls: ModelCall[], tool: ToolCallEvent): boolean {
  if (tool.phase === undefined) {
    calls.push({
      name: tool.name,
      callId: tool.callId,
      arguments: tool.arguments,
      ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}),
    });
    return true;
  }
  const call = findLast(calls, (held) => held.callId === tool.callId);
  if (tool.phase !== 'error' || !call) return false;
  call.failure = tool.failure;
  return true;
}

/** The step's request, with what it gives the model noted on `state`, and its call's usage and trace. */
function startProviderCall(
  generation: ResolvedGeneration,
  system: BoundSystem,
  state: StepExecutionState,
  answerOnly: boolean,
) {
  const usage = startCallUsage(system.text, {
    history: state.currentHistory,
    input: generation.input,
  });
  state.lastCall = usage;
  const genForStep = generationForProviderStep(generation, state, answerOnly);
  const request = providerCompleteRequest(state.tools, genForStep, system.text);
  addRequestUrls(state.givenUrls, request);
  addRequestDestinations(state.destinations, request, state.givenUrls.own);
  if (generation.canary && !state.canaryGiven) {
    state.canaryGiven = requestGivesCanary(request, generation.canary, state.canaryScanned);
  }
  state.trace.calls += 1;
  const call = startCallTrace((name, options) => state.trace.root.child(name, options), {
    req: request,
    usage,
    binding: state.trace.binding,
    transport: genForStep.transport,
    step: state.stepCount,
    attempt: state.trace.attempt,
  });
  return { usage, genForStep, request, call };
}

/** What a model call left: its tool calls, its structured reply, and whether it is to be sent again. */
interface StepOutcome {
  calls: ModelCall[];
  latestStructured?: unknown;
  resume?: { stop: TurnStop; failure: TurnEventOf<'error'> | undefined };
}

/**
 * True when the profile itself lists the stop in `turnBehaviour.resumption.autoContinue`.
 *
 * why: `DEFAULT_AUTO_CONTINUE` advises a host; a turn spends another model call only where the profile says so.
 */
function resendsFailedCall(profile: Profile, stop: TurnStop): boolean {
  const policy = profileTurnResumption(profile);
  return policy?.autoContinue !== undefined && shouldAutoContinue(stop, policy);
}

/** The events that are a model call's reply, as opposed to its thoughts, usage or failure. */
const REPLY_EVENTS: ReadonlySet<TurnEvent['type']> = new Set([
  'text',
  'media',
  'structured',
  'citation',
]);

/** What one model call has given so far. */
interface CallTally {
  calls: ModelCall[];
  latestStructured?: unknown;
  /** The stop the call ended with after gates: a canary block or provider error outranks what the provider reported. */
  stop?: TurnStop;
  /** why: A call's failure is the turn's only once the call is not sent again, so it waits for the call's end. */
  failures: TurnEventOf<'error'>[];
  replied: boolean;
}

/** Takes what an event says about the call itself. True when the event goes no further. */
function tallyCallEvent(
  event: TurnEvent,
  tally: CallTally,
  call: ReturnType<typeof startProviderCall>['call'],
): boolean {
  if (event.type === 'error') {
    tally.failures.push(event);
    return true;
  }
  if (event.type === 'tool') return holdModelCall(tally.calls, event.tool);
  if (event.type === 'guardrail') call.guardrail(event.guardrail);
  if (event.type === 'structured') tally.latestStructured = event.structured;
  if (REPLY_EVENTS.has(event.type)) tally.replied = true;
  return false;
}

/** Records an event the call gave. True when the host gets it now. */
function releasesNow(
  event: TurnEvent,
  control: OutboundStreamControl,
  state: StepExecutionState,
  buffer: { holdLate: boolean; holdVisible: boolean },
): boolean {
  recordStepEvent(event, state);
  if (control.withholdVisible && isWithheldOnBlock(event)) {
    // why: Progressive-yield blocked this attempt — keep events for egress/repair only.
    // Record the decision so the attempt gate knows nothing reached the host.
    state.withheldVisible = true;
    return false;
  }
  if (event.type === 'text') state.released += event.text;
  // why: Text and media stream via progressive-yield under egress, thoughts
  // stream unguarded; holdLate only buffers non-visible events (e.g.
  // structured) for validation.
  const isUserVisible =
    event.type === 'thought' || (!buffer.holdVisible && isWithheldOnBlock(event));
  return !buffer.holdLate || isUserVisible;
}

// why: Every other kind is the provider's answer to the request itself (it refused a part, a key, a setting); the same call sent again gets the same answer.
const PASSING_ERROR_KINDS: ReadonlySet<ErrorKind> = new Set([
  'unavailable',
  'bad_response',
  'network',
  'timeout',
  'rate_limit',
]);

/**
 * The re-send a finished call is due, if any.
 *
 * A failure the same call would meet again is not sent again (`PASSING_ERROR_KINDS`).
 *
 * why: A failed call that gave no reply and no tool call left nothing behind, so sending it again repeats
 * nothing. A reply cut at `length` is not a failure: the same call would be cut at the same place.
 */
function resumeOf(mayResume: boolean, profile: Profile, tally: CallTally): StepOutcome['resume'] {
  const { stop } = tally;
  if (!mayResume || tally.replied || tally.calls.length > 0 || !stop) return undefined;
  if (!isFailedStopKind(stop.kind) || !resendsFailedCall(profile, stop)) return undefined;
  const failure = tally.failures[0];
  if (failure?.errorKind && !PASSING_ERROR_KINDS.has(failure.errorKind)) return undefined;
  return { stop, failure };
}

/** Carries what the call's stream guards still hold into the turn's next call. */
function keepStreamCarry(state: StepExecutionState, control: OutboundStreamControl): void {
  state.canaryCarry = control.canaryCarry;
  state.thoughtCarry = control.thoughtCarry;
  if (control.promptLeaks) {
    state.promptLeaks = [...(state.promptLeaks ?? []), ...control.promptLeaks];
  }
}

async function* executeAutonomousStep(
  args: {
    profile: Profile;
    generation: ResolvedGeneration;
    system: BoundSystem;
    provider: ModelProvider;
    signal?: AbortSignal;
    /** True while the turn has a re-send left under the profile's resumption. */
    mayResume: boolean;
  },
  state: StepExecutionState,
  buffer: { holdLate: boolean; holdVisible: boolean } = {
    holdLate: false,
    holdVisible: false,
  },
): AsyncGenerator<TurnEvent, StepOutcome> {
  const { profile, generation, system, provider, signal } = args;
  const { usage, genForStep, request, call } = startProviderCall(
    generation,
    system,
    state,
    isAnswerOnlyStep(profile, generation, state.stepCount),
  );
  const tally: CallTally = { calls: [], failures: [], replied: false };
  const control: OutboundStreamControl = {
    withholdVisible: false,
    ...(state.canaryCarry ? { canaryCarry: state.canaryCarry } : {}),
    ...(state.thoughtCarry ? { thoughtCarry: state.thoughtCarry } : {}),
  };

  try {
    for await (const event of yieldProviderEvents({
      profile: args.profile,
      generation: genForStep,
      request,
      privateSystem: system.private,
      provider,
      call,
      signal,
      control,
      givenUrls: state.givenUrls,
      canaryGiven: state.canaryGiven,
      ...(state.ownTools ? { ownTools: state.ownTools } : {}),
    })) {
      if (observeCallEvent(usage, event)) continue;
      if (event.type === 'done') {
        state.providerState = event.providerState;
        tally.stop = event.stop;
        state.lastStop = event.stop;
        continue;
      }
      if (tallyCallEvent(event, tally, call)) continue;
      if (releasesNow(event, control, state, buffer)) yield event;
    }
  } catch (err) {
    call.end(
      isAbortError(err) ? { stop: { kind: 'cancelled' } } : { stop: tally.stop, thrown: err },
    );
    throw err;
  }

  keepStreamCarry(state, control);
  const resume = resumeOf(args.mayResume, profile, tally);
  if (!resume) {
    for (const failure of tally.failures) {
      recordStepEvent(failure, state);
      if (!buffer.holdLate) yield failure;
    }
  }
  const tokens = await callTokensEvent(usage, generation, state.mediaFamily);
  call.end({ tokens: tokens?.tokens, stop: tally.stop });
  if (tokens) {
    recordStepEvent(tokens, state);
    yield tokens;
  }

  return {
    calls: tally.calls,
    latestStructured: tally.latestStructured,
    ...(resume ? { resume } : {}),
  };
}

/**
 * One step of a text turn. A model call that fails (`provider_error`,
 * `stream_incomplete`) on a kind the profile's own `turnBehaviour.resumption.autoContinue`
 * lists, having given no reply and no tool call, is sent again in the same turn
 * after a pause, up to `maxContinues` times a turn (once when the profile sets
 * none). The turn's history, its step count and what it has read stay as they were.
 */
async function* executeResumedStep(
  args: Omit<Parameters<typeof executeAutonomousStep>[0], 'mayResume'>,
  state: StepExecutionState,
  buffer: { holdLate: boolean; holdVisible: boolean },
): AsyncGenerator<TurnEvent, StepOutcome> {
  const limit = profileTurnResumption(args.profile)?.maxContinues ?? 1;
  for (;;) {
    const mayResume = args.profile.type === 'text' && state.resumes < limit;
    const outcome = yield* executeAutonomousStep({ ...args, mayResume }, state, buffer);
    if (!outcome.resume) return outcome;
    state.resumes += 1;
    const detail = outcome.resume.failure?.errorInternal ?? outcome.resume.failure?.error;
    state.trace.root.event('theorem.step.resume', {
      step: state.stepCount,
      resume: state.resumes,
      stop: outcome.resume.stop.kind,
      ...(detail ? { error: detail } : {}),
    });
    state.lastStop = undefined;
    await waitDefault(AUTO_CONTINUE_DELAY_MS, args.signal);
  }
}

function toolResultMessage(call: ModelCall, result: ModelToolResult): TurnHistoryMessage {
  return {
    role: 'tool',
    tool_call_id: call.callId,
    name: call.name,
    content: formatToolResult(result),
    ...(result.parts && result.parts.length > 0 ? { parts: result.parts } : {}),
  };
}

/**
 * One step's calls as one assistant message, the way the model made them.
 * Providers read a step's calls together, then their results: Google rejects
 * a call replayed after an earlier call's result (probe 25/09/2026).
 */

/** Record the approved read-back in portable history. */
function recordToolModelResult(
  state: StepExecutionState,
  call: ModelCall,
  modelResult: ModelToolResult,
): void {
  state.currentHistory.push(toolResultMessage(call, modelResult));
}

async function* forwardToolEvents(
  exec: AsyncGenerator<TurnEvent, ToolExecuteSettlement>,
  state: StepExecutionState,
): AsyncGenerator<TurnEvent, ToolExecuteSettlement> {
  let next = await exec.next();
  while (!next.done) {
    state.allEmittedEvents.push(next.value);
    yield next.value;
    next = await exec.next();
  }
  return next.value;
}

function toolSpanOpener(state: StepExecutionState) {
  return (name: string, attributes: TraceAttributes) =>
    state.trace.root.child(name, { attributes });
}

/**
 * Settle a call the provider handed over already failed (malformed arguments,
 * no function name): nothing runs, and the model reads the failure back.
 */
function recordProviderToolFailure(
  state: StepExecutionState,
  call: ModelCall,
  failure: ToolFailure,
): TurnEvent {
  const event = failureEvent(call, failure);
  state.allEmittedEvents.push(event);
  const modelResult = formatToolFailureForModel(failure);
  startToolTrace(toolSpanOpener(state), {
    name: call.name,
    callId: call.callId,
    call,
    step: state.stepCount,
  }).end({
    outcome: 'error',
    result: { text: formatToolResult(modelResult) },
    failure,
  });
  recordToolModelResult(state, call, modelResult);
  return event;
}

function* applyToolSettlement(
  settlement: ToolExecuteSettlement,
  state: StepExecutionState,
  call: ModelCall,
): Generator<TurnEvent, 'continue' | 'stop_cancelled' | 'gated'> {
  if (settlement.aborted) {
    state.lastStop = stageAbortStop(settlement.aborted);
    return 'stop_cancelled';
  }
  if (settlement.gated) {
    return 'gated';
  }
  if (settlement.modelResult?.provenance) {
    state.taint = recordTaint(
      state.taint,
      settlement.modelResult.provenance,
      settlement.modelResult.suspicious,
    );
    addResultDestinations(
      state.destinations,
      settlement.modelResult,
      settlement.modelResult.provenance,
    );
  }
  if (!settlement.modelResult) return 'continue';
  if (!settlement.failure && 'outputRaw' in settlement) {
    state.toolResults.push({ tool: call.name, output: settlement.outputRaw });
  }
  recordToolModelResult(state, call, settlement.modelResult);
  if (settlement.pendingInject) {
    yield* applyStageInjects(state, 'post_tool', settlement.pendingInject, {
      callId: call.callId,
      toolName: call.name,
    });
  }
  return 'continue';
}

/**
 * Runs tools side by side and passes on each event as it comes. Returns each run's
 * settlement by its place in `runs`, `undefined` where there was no run.
 *
 * why: One run that throws ends them all; the rest are closed so none keeps running unseen.
 */
async function* runSideBySide<T>(
  runs: (AsyncGenerator<TurnEvent, T | undefined> | undefined)[],
): AsyncGenerator<TurnEvent, (T | undefined)[]> {
  const settled: (T | undefined)[] = runs.map(() => undefined);
  const waiting = new Map<
    number,
    Promise<{ index: number; next: IteratorResult<TurnEvent, T | undefined> }>
  >();
  const pull = (index: number, run: AsyncGenerator<TurnEvent, T | undefined>) => {
    const next = run.next().then((result) => ({ index, next: result }));
    // why: A run that fails after another already threw is closed below; its failure has nowhere to go.
    next.catch(() => {});
    waiting.set(index, next);
  };
  runs.forEach((run, index) => {
    if (run) pull(index, run);
  });
  try {
    while (waiting.size > 0) {
      const { index, next } = await Promise.race(waiting.values());
      waiting.delete(index);
      const run = runs[index];
      if (next.done || !run) {
        if (next.done) settled[index] = next.value;
        continue;
      }
      yield next.value;
      pull(index, run);
    }
  } finally {
    for (const index of waiting.keys()) {
      runs[index]?.return(undefined).catch(() => {});
    }
  }
  return settled;
}

/**
 * Run the model's calls side by side. Each reaches the host as its raw call first,
 * all of them before any runs; their phases then arrive as each tool gives them. A call
 * the provider handed over already failed does not run. A call reads the turn's taint
 * and destinations as they stood when the step began: the model chose every call in
 * the step before any of their results came back.
 *
 * Results are recorded in the order the model made the calls, each followed by its
 * `post_tool` inject. A call that gates waits for its own approval while the others run.
 * After the step, any gate stops the turn. A call a stage cancelled stops the turn too,
 * once every result that did come back is recorded.
 */
async function* handleModelCalls(
  upstreamCalls: ModelCall[],
  generation: ResolvedGeneration,
  profile: Profile,
  state: StepExecutionState,
  system: BoundSystem,
  { onStage, signal, credentials, resolveHost }: Partial<TurnRequest> = {},
): AsyncGenerator<TurnEvent, boolean> {
  if (upstreamCalls.length > 0) {
    state.currentHistory.push(historyToolCalls(upstreamCalls));
  }
  const stepId = crypto.randomUUID();
  const leakScope = {
    canary: generation.canary,
    canaryGiven: state.canaryGiven,
    privateSystem: system.private,
  };
  const announce = (call: ModelCall): TurnEvent => {
    // why: The host is shown the call as its tool gets it; a failed call never reaches a tool.
    const shown = call.failure
      ? call.arguments
      : shownToolArguments({
          tools: state.tools,
          profile,
          name: call.name,
          input: call.arguments,
          scope: leakScope,
        });
    const request = toolCallRequestEvent(call, shown, {
      thoughtSignature: call.thoughtSignature,
      stepId,
    });
    state.allEmittedEvents.push(request);
    return request;
  };
  const calls = upstreamCalls.map((call) => ({ ...call, operationId: crypto.randomUUID() }));
  for (const call of calls) yield announce(call);

  const stages: ToolStageSupport = {
    handlers: onStage ? [onStage] : [],
    profile,
    step: state.stepCount,
    history: () => state.currentHistory,
    injectAllowed: profileAllowsInject(profile),
    injectWouldExceedMaxSteps: injectWouldExceedMaxSteps(state.stepCount, generation.maxSteps),
    host: generation.host,
    signal,
  };
  const turn = { step: state.stepCount, taint: state.taint, destinations: state.destinations };
  const settlements = yield* runSideBySide(
    calls.map((call) =>
      call.failure
        ? undefined
        : forwardToolEvents(
            executeRegisteredTool({
              tools: state.tools,
              execution: generation.execution,
              invocation: {
                model: generation.model,
                input: generation.input,
                history: generation.history,
              },
              ...(state.agents ? { agents: state.agents } : {}),
              profile,
              name: call.name,
              input: call.arguments,
              callId: call.callId,
              ctx: {
                operationId: call.operationId,
                pageExecution: generation.pageExecution,
                sessionPermissions: generation.sessionPermissions,
                path: generation.tools.path,
                turn,
                credentials,
                resolveHost,
                host: generation.host,
                resume: undefined,
                signal,
              },
              snapshot: generation.tools,
              stages,
              scope: leakScope,
              openSpan: toolSpanOpener(state),
            }),
            state,
          ),
    ),
  );

  let gated = false;
  let cancelled = false;
  for (const [index, call] of calls.entries()) {
    if (call.failure) {
      yield recordProviderToolFailure(
        state,
        { ...call, activityFailed: failedActivity(call.name, profile.labels) },
        call.failure,
      );
      continue;
    }
    const settlement = settlements[index];
    if (!settlement) continue;
    const outcome = yield* applyToolSettlement(settlement, state, call);
    if (outcome === 'stop_cancelled') cancelled = true;
    if (outcome === 'gated') gated = true;
  }
  if (cancelled) return false;
  if (gated) {
    state.lastStop = { kind: 'gate' };
    return false;
  }
  return calls.length > 0;
}

async function* executeAttempt(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ResolvedGeneration;
  system: BoundSystem;
  provider: ModelProvider;
  state: StepExecutionState;
}): AsyncGenerator<TurnEvent, { latestStructured?: unknown }> {
  const { profile, generation, system, provider, state } = args;
  let latestStructured: unknown;
  // why: Text streams via progressive-yield under egress, thoughts unguarded; validation and egress
  // both hold non-visible events (structured) until the attempt gate, so a policy
  // sees the structured payload before any of it reaches the host.
  const validation = profileTurnOutputs(profile)?.validation;
  const holdLate =
    validation !== undefined ||
    replyIsJudged(resolveGuardrailPolicy(profile.guardrails), TURN_REPLY);
  // why: Buffered delivery holds each attempt's text and media until it passes; streamed delivery shows them live.
  const holdVisible = validation !== undefined && generation.stream === false;

  // why: Ceiling is cumulative `state.stepCount` across before_end inject re-entries
  // within this attempt. Validation/egress repair resets stepCount at the start
  // of each attempt cycle.
  while (!isStepLimitReached(state.stepCount, generation.maxSteps ?? 0)) {
    throwIfAborted(args.safe.signal);
    state.stepCount++;
    // why: Mid-loop inject lives on `post_tool` (after tools). Opening inject is `pre_turn`
    // outside this loop.
    const stepResult = yield* executeResumedStep(
      { profile, generation, system, provider, signal: args.safe.signal },
      state,
      { holdLate, holdVisible },
    );
    if (stepResult.latestStructured !== undefined) {
      latestStructured = stepResult.latestStructured;
    }
    const executed = yield* handleModelCalls(
      stepResult.calls,
      generation,
      profile,
      state,
      system,
      args.safe,
    );
    if (!executed) {
      break;
    }
    // why: The tools ran and no step is left to read them, so the turn has no answer.
    if (isStepLimitReached(state.stepCount, generation.maxSteps ?? 0)) {
      state.lastStop = { kind: 'step_limit' };
    }
  }

  return { latestStructured };
}

export { executeAttempt };
