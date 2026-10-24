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
import { ANSWER_TOOL, answersByTool, withAnswerTool } from '../../answer-tool.ts';
import { stepReplyMessages } from '../../interaction-parts.ts';
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
import { profileToolsParallel } from '../../tools/resolve.ts';
import type { ModelToolResult, ToolCallEvent, ToolFailure } from '../../tools/types.ts';
import type { ReasoningPart } from '../../turn-events.ts';
import type {
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnEventOf,
  TurnHistoryMessage,
  TurnModel,
  TurnRequest,
  TurnStop,
} from '../../types.ts';
import { findLast } from '../../util/find-last.ts';
import { startToolTrace } from '../tool-trace.ts';
import { startCallTrace } from '../turn-trace.ts';
import { applyStageInjects, recordReply } from './stages.ts';
import { modelHistory, recordStepEvent, type StepExecutionState } from './state.ts';
import { inStep, runSideBySide, stepOrder } from './step-order.ts';
import {
  isWithheldOnBlock,
  type OutboundStreamControl,
  StructuredDrafts,
  yieldProviderEvents,
} from './stream.ts';
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
  const forStep = { ...generation, history: modelHistory(state) };
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
  labels: Profile['labels'],
) {
  const usage = startCallUsage(system.text, {
    history: modelHistory(state),
    input: generation.input,
  });
  state.lastCall = usage;
  const genForStep = generationForProviderStep(generation, state, answerOnly);
  const request = withAnswerTool(
    providerCompleteRequest(state.tools, genForStep, system.text),
    generation,
    labels,
  );
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
  /** The signed reasoning the call wrote, to go back on the assistant message with its calls. */
  reasoning: ReasoningPart[];
  /** The text the call wrote, as its stream guards passed it on. */
  text: string;
  /** Where that text begins in the attempt's reply, past the break that sets it apart. */
  replyAt?: number;
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

/** The events that are a model call's reply, as opposed to its thoughts, usage, or failure. */
const REPLY_EVENTS: ReadonlySet<TurnEvent['type']> = new Set([
  'text',
  'media',
  'structured',
  'citation',
]);

/** What one model call has given so far. */
interface CallTally {
  calls: ModelCall[];
  reasoning: ReasoningPart[];
  text: string;
  latestStructured?: unknown;
  /** The stop the call ended with after gates: a canary block or provider error outranks what the provider reported. */
  stop?: TurnStop;
  /** why: A call's failure is the turn's only once the call is not sent again, so it waits for the call's end. */
  failures: TurnEventOf<'error'>[];
  replied: boolean;
  /** Where the call's text begins in the attempt's reply (`StepExecutionState.replyText`). */
  replyAt?: number;
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
  if (event.type === 'text') tally.text += event.text;
  if (REPLY_EVENTS.has(event.type)) tally.replied = true;
  return false;
}

/**
 * The structured output the call gave through the answer tool, shown as the step's, with the answer
 * tool's calls taken out of the step's calls. An answer ends the turn, so the step's other calls do
 * not run, and the call that gave it completed.
 */
async function* showAnswer(
  shown: StructuredDrafts,
  tally: CallTally,
  step: {
    generation: ResolvedGeneration;
    state: StepExecutionState;
    control: OutboundStreamControl;
    buffer: { holdLate: boolean; holdVisible: boolean };
    call: ReturnType<typeof startProviderCall>['call'];
  },
): AsyncGenerator<TurnEvent> {
  if (!answersByTool(step.generation)) return;
  const answer = tally.calls.find((call) => call.name === ANSWER_TOOL && !call.failure);
  tally.calls = answer ? [] : tally.calls.filter((call) => call.name !== ANSWER_TOOL);
  if (!answer) return;
  if (tally.stop?.kind === 'tool') {
    tally.stop = { kind: 'completed' };
    step.state.lastStop = tally.stop;
  }
  const event: TurnEventOf<'structured'> = { type: 'structured', structured: answer.arguments };
  if (tallyCallEvent(event, tally, step.call)) return;
  if (releasesNow(event, step.control, step.state, step.buffer)) yield* shown.show(event);
}

/**
 * A tool call's preview. The answer tool's streams as the structured reply's draft.
 *
 * why: A preview of the call that follows, which owns the arguments: not the turn's record. It streams
 * as the reply's text does, through its own gate, and like that text is held only when delivery is buffered.
 */
async function* showToolDraft(
  event: TurnEventOf<'tool_draft'>,
  shown: StructuredDrafts,
  generation: ResolvedGeneration,
  buffer: { holdVisible: boolean },
): AsyncGenerator<TurnEvent> {
  if (buffer.holdVisible) return;
  if (event.name === ANSWER_TOOL && answersByTool(generation)) yield* shown.draft(event.text);
  else yield event;
}

/** What sets one model call's text apart from the reply text before it: a blank line. */
const CALL_BREAK = '\n\n';

/**
 * The call's first text, set apart from the attempt's reply before it.
 *
 * why: Each model call writes as if it starts the message, so a reply that goes on after tools or
 * an inject would otherwise run its first word into the last one ("…full picture.Here's").
 */
function withCallBreak(
  event: TurnEventOf<'text'>,
  tally: CallTally,
  state: StepExecutionState,
  generation: ResolvedGeneration,
): TurnEventOf<'text'> {
  if (tally.text) return event;
  const before = state.replyText;
  const prose = generation.structured === null || answersByTool(generation);
  const breaks = before && prose && !/\s$/.test(before) && !/^\s/.test(event.text);
  tally.replyAt = before.length + (breaks ? CALL_BREAK.length : 0);
  return breaks ? { ...event, text: `${CALL_BREAK}${event.text}` } : event;
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
  if (event.type === 'text') {
    state.released += event.text;
    state.replyText += event.text;
  }
  // why: Text and media stream via progressive-yield under egress, thoughts
  // stream unguarded; holdLate only buffers non-visible events (e.g.
  // structured) for validation.
  const isUserVisible =
    event.type === 'thought' || (!buffer.holdVisible && isWithheldOnBlock(event));
  return !buffer.holdLate || isUserVisible;
}

// why: Every other kind is the provider's answer to the request itself (it refused a part, a key, a setting); the same call sent again gets the same answer.
const PASSING_ERROR_KINDS: ReadonlySet<ErrorKind> = new Set([
  'busy',
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
    provider: TurnModel;
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
    profile.labels,
  );
  const tally: CallTally = { calls: [], reasoning: [], text: '', failures: [], replied: false };
  const control: OutboundStreamControl = {
    withholdVisible: false,
    ...(state.canaryCarry ? { canaryCarry: state.canaryCarry } : {}),
    ...(state.thoughtCarry ? { thoughtCarry: state.thoughtCarry } : {}),
  };

  const seen = {
    profile: args.profile,
    generation: genForStep,
    privateSystem: system.private,
    givenUrls: state.givenUrls,
    canaryGiven: state.canaryGiven,
    ...(state.ownTools ? { ownTools: state.ownTools } : {}),
  };
  const shown = new StructuredDrafts({ ...seen, generation });

  try {
    for await (const event of yieldProviderEvents({
      ...seen,
      request,
      provider,
      call,
      signal,
      control,
      tools: state.tools,
      answerTool: answersByTool(generation),
    })) {
      if (observeCallEvent(usage, event)) continue;
      if (event.type === 'reasoning') {
        const { type: _type, ...part } = event;
        tally.reasoning.push(part);
        continue;
      }
      if (event.type === 'done') {
        state.providerState = event.providerState;
        tally.stop = event.stop;
        state.lastStop = event.stop;
        continue;
      }
      if (event.type === 'tool_draft') {
        yield* showToolDraft(event, shown, generation, buffer);
        continue;
      }
      // why: The model's history keeps what it wrote; only the reply the host gets is set apart.
      const next = event.type === 'text' ? withCallBreak(event, tally, state, generation) : event;
      if (tallyCallEvent(event, tally, call)) continue;
      if (!releasesNow(next, control, state, buffer)) continue;
      yield* shown.show(next);
    }
  } catch (err) {
    call.end(
      isAbortError(err) ? { stop: { kind: 'cancelled' } } : { stop: tally.stop, thrown: err },
    );
    throw err;
  }

  yield* shown.end();
  yield* showAnswer(shown, tally, { generation, state, control, buffer, call });
  keepStreamCarry(state, control);
  const resume = resumeOf(args.mayResume, profile, tally);
  if (!resume) {
    for (const failure of tally.failures) {
      recordStepEvent(failure, state);
      if (!buffer.holdLate) yield failure;
    }
  }
  const tokens = await callTokensEvent(usage, generation);
  call.end({ tokens: tokens?.tokens, stop: tally.stop });
  if (tokens) {
    recordStepEvent(tokens, state);
    yield tokens;
  }

  return {
    calls: tally.calls,
    reasoning: tally.reasoning,
    text: tally.text,
    latestStructured: tally.latestStructured,
    ...(tally.replyAt === undefined ? {} : { replyAt: tally.replyAt }),
    ...(resume ? { resume } : {}),
  };
}

/**
 * One step of a text turn. A model call that fails (`provider_error`,
 * `stream_incomplete`) on a kind the profile's own `turnBehaviour.resumption.autoContinue`
 * lists, having given no reply and no tool call, is sent again in the same turn
 * after a pause, up to `maxContinues` times a turn (once when the profile sets
 * none). The turn's history, its step count, and what it has read stay as they were.
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

/** A step's reply as the model reads it back: its text, then its calls with the reasoning before them. */
function stepReply(outcome: StepOutcome): TurnHistoryMessage[] {
  return stepReplyMessages({
    text: outcome.text,
    structured: outcome.latestStructured,
    calls: outcome.calls.map((call, index) =>
      index === 0 ? { ...call, reasoning: outcome.reasoning } : call,
    ),
  });
}

/**
 * Run the model's calls. Each reaches the host as its raw call first, all of them before
 * any runs; their phases then arrive as each tool gives them. With `tools.parallel` they
 * run side by side; otherwise one at a time, in the order the model made them. A call
 * whose `pre_tool` answers `waitFor` starts its body once those calls settle
 * (`step-order.ts`). A call the provider handed over already failed does not run. A call
 * reads the turn's taint, destinations, and visible tools as they stood when the step
 * began: the model chose every call in the step before any of their results came back.
 *
 * Results are recorded in the order the model made the calls, each followed by its
 * `post_tool` inject. A call that gates waits for its own approval while the others run.
 * After the step, any gate stops the turn. A call a stage cancelled stops the turn too,
 * once every result that did come back is recorded.
 */
async function* handleModelCalls(
  outcome: StepOutcome,
  generation: ResolvedGeneration,
  profile: Profile,
  state: StepExecutionState,
  system: BoundSystem,
  { onStage, signal, credentials, resolveHost }: Partial<TurnRequest> = {},
): AsyncGenerator<TurnEvent, boolean> {
  const { calls: upstreamCalls, reasoning } = outcome;
  if (upstreamCalls.length > 0) recordReply(state, stepReply(outcome), outcome.replyAt);
  const stepId = crypto.randomUUID();
  const leakScope = {
    canary: generation.canary,
    canaryGiven: state.canaryGiven,
    privateSystem: system.private,
  };
  const calls = upstreamCalls.map((call) => ({
    ...call,
    operationId: crypto.randomUUID(),
    // why: The host and every `pre_tool` see the call as its tool gets it; a failed call never reaches a tool.
    shown: call.failure
      ? call.arguments
      : shownToolArguments({
          tools: state.tools,
          profile,
          name: call.name,
          input: call.arguments,
          scope: leakScope,
        }),
  }));
  for (const [index, call] of calls.entries()) {
    const request = toolCallRequestEvent(call, call.shown, {
      ...(index === 0 && reasoning.length ? { reasoning } : {}),
      stepId,
      stepCallCount: calls.length,
    });
    state.allEmittedEvents.push(request);
    yield request;
  }
  const order = stepOrder(
    calls.map((call) => call.callId),
    profileToolsParallel(profile) === true,
    signal,
  );

  const stages: ToolStageSupport = {
    handlers: onStage ? [onStage] : [],
    profile,
    step: state.stepCount,
    history: () => state.currentHistory,
    injectAllowed: profileAllowsInject(profile),
    injectWouldExceedMaxSteps: injectWouldExceedMaxSteps(state.stepCount, generation.maxSteps),
    host: generation.host,
    signal,
    stepCalls: calls.map((call) => ({ callId: call.callId, tool: call.name, input: call.shown })),
    wait: order.wait,
    drafts: generation.stream !== false,
  };
  const turn = {
    step: state.stepCount,
    taint: state.taint,
    destinations: state.destinations,
    visible: [...generation.tools.visible],
  };
  const execute = (call: (typeof calls)[number]) =>
    forwardToolEvents(
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
    );
  for (const call of calls) {
    if (call.failure) order.settle(call.callId);
  }
  const settlements = yield* runSideBySide(
    calls.map((call) =>
      call.failure ? undefined : inStep(order, call.callId, () => execute(call)),
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
  provider: TurnModel;
  state: StepExecutionState;
}): AsyncGenerator<
  TurnEvent,
  { latestStructured?: unknown; reply: TurnHistoryMessage[]; replyAt?: number }
> {
  const { profile, generation, system, provider, state } = args;
  let latestStructured: unknown;
  // why: The answer that ends the attempt is not in turn history; a `before_end` inject puts it there first.
  let reply: TurnHistoryMessage[] = [];
  let replyAt: number | undefined;
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
    reply = stepResult.calls.length > 0 ? [] : stepReply(stepResult);
    replyAt = stepResult.replyAt;
    const executed = yield* handleModelCalls(
      stepResult,
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

  return { latestStructured, reply, ...(replyAt === undefined ? {} : { replyAt }) };
}

export { executeAttempt };
