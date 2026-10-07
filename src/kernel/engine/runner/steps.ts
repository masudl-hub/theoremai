import { requestGivesCanary } from '../../../guardrails/canary.ts';
import { addRequestDestinations, addResultDestinations } from '../../../guardrails/destinations.ts';
import { TURN_REPLY } from '../../../guardrails/detect-reply.ts';
import { addRequestUrls } from '../../../guardrails/egress-urls.ts';
import { isAbortError, throwIfAborted } from '../../../guardrails/error.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { replyIsJudged } from '../../../guardrails/progressive-yield.ts';
import { recordTaint } from '../../../guardrails/tool-result.ts';
import type { TraceAttributes } from '../../../observability/trace-span.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { providerCompleteRequest } from '../../registry/provider-request.ts';
import { injectWouldExceedMaxSteps } from '../../stages.ts';
import { profileAllowsInject, stageAbortStop } from '../../stop.ts';
import type { BoundSystem } from '../../system-parts.ts';
import { failureEvent, type ToolCallBase, toolCallRequestEvent } from '../../tools/events.ts';
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
  ProviderEvent,
  ResolvedGeneration,
  TurnEvent,
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

function generationForProviderStep(
  generation: ResolvedGeneration,
  state: StepExecutionState,
): ResolvedGeneration {
  if (state.interactionsContinuation) {
    const { previousInteractionId, messages } = state.interactionsContinuation;
    state.interactionsContinuation = undefined;
    return {
      ...generation,
      history: [],
      input: [],
      previousInteractionId,
      continuation: [...messages],
    };
  }
  return { ...generation, history: state.currentHistory };
}

function captureInteractionId(event: ProviderEvent, state: StepExecutionState): void {
  if ((event.type === 'tokens' || event.type === 'done') && event.interactionId) {
    state.lastInteractionId = event.interactionId;
  }
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
) {
  const continuation = state.interactionsContinuation;
  const usage = startCallUsage(
    system.text,
    continuation && state.lastCall
      ? { previous: state.lastCall, continuation: continuation.messages }
      : { history: state.currentHistory, input: generation.input },
  );
  state.lastCall = usage;
  const genForStep = generationForProviderStep(generation, state);
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

async function* executeAutonomousStep(
  args: {
    profile: Profile;
    generation: ResolvedGeneration;
    system: BoundSystem;
    provider: ModelProvider;
    signal?: AbortSignal;
  },
  state: StepExecutionState,
  buffer: { holdLate: boolean; holdVisible: boolean } = {
    holdLate: false,
    holdVisible: false,
  },
): AsyncGenerator<TurnEvent, { calls: ModelCall[]; latestStructured?: unknown }> {
  const { generation, system, provider, signal } = args;
  const { usage, genForStep, request, call } = startProviderCall(generation, system, state);
  const calls: ModelCall[] = [];
  let latestStructured: unknown;
  // why: The stop this call ended with after gates: a canary block or provider
  // error outranks what the provider reported.
  let stop: TurnStop | undefined;
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
      captureInteractionId(event, state);
      if (observeCallEvent(usage, event)) {
        continue;
      }
      if (event.type === 'guardrail') {
        call.guardrail(event.guardrail);
      }
      if (event.type === 'structured') {
        latestStructured = event.structured;
      }
      if (event.type === 'done') {
        stop = event.stop;
        state.lastStop = event.stop;
        continue;
      }
      if (event.type === 'tool' && holdModelCall(calls, event.tool)) {
        continue;
      }
      recordStepEvent(event, state);
      if (control.withholdVisible && isWithheldOnBlock(event)) {
        // why: Progressive-yield blocked this attempt — keep events for egress/repair only.
        // Record the decision so the attempt gate knows nothing reached the host.
        state.withheldVisible = true;
        continue;
      }
      if (event.type === 'text') state.released += event.text;
      // why: Text and media stream via progressive-yield under egress, thoughts
      // stream unguarded; holdLate only buffers non-visible events (e.g.
      // structured) for validation.
      const isUserVisible =
        event.type === 'thought' || (!buffer.holdVisible && isWithheldOnBlock(event));
      const streamNow = !buffer.holdLate || isUserVisible;
      if (streamNow) {
        yield event;
      }
    }
  } catch (err) {
    call.end(isAbortError(err) ? { stop: { kind: 'cancelled' } } : { stop, thrown: err });
    throw err;
  }

  state.canaryCarry = control.canaryCarry;
  state.thoughtCarry = control.thoughtCarry;
  if (control.promptLeaks) {
    state.promptLeaks = [...(state.promptLeaks ?? []), ...control.promptLeaks];
  }
  const tokens = await callTokensEvent(usage, generation, state.mediaFamily);
  call.end({ tokens: tokens?.tokens, stop });
  if (tokens) {
    recordStepEvent(tokens, state);
    yield tokens;
  }

  return { calls, latestStructured };
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
function stepCallsMessage(calls: readonly ModelCall[]): TurnHistoryMessage {
  return {
    role: 'assistant',
    tool_calls: calls.map((call) => ({
      id: call.callId,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
    })),
  };
}

/**
 * The stored interaction a step's results chain on, or `undefined` when they go
 * in history: the turn does not chain, or no interaction id arrived to chain on.
 */
function chainedInteractionId(
  generation: ResolvedGeneration,
  state: StepExecutionState,
): string | undefined {
  return generation.chains
    ? (state.lastInteractionId ?? generation.previousInteractionId)
    : undefined;
}

function queueInteractionsToolContinuation(
  state: StepExecutionState,
  message: TurnHistoryMessage,
  previousInteractionId: string,
): void {
  if (state.interactionsContinuation?.previousInteractionId === previousInteractionId) {
    state.interactionsContinuation.messages.push(message);
    return;
  }
  state.interactionsContinuation = { previousInteractionId, messages: [message] };
}

/** A call's result: chained on the stored interaction, else after the step's calls in history. */
function recordToolModelResult(
  state: StepExecutionState,
  call: ModelCall,
  modelResult: ModelToolResult,
  chainOn: string | undefined,
): void {
  const message = toolResultMessage(call, modelResult);
  if (chainOn) {
    queueInteractionsToolContinuation(state, message, chainOn);
    return;
  }
  state.currentHistory.push(message);
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
  chainOn: string | undefined,
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
  recordToolModelResult(state, call, modelResult, chainOn);
  return event;
}

function* applyToolSettlement(
  settlement: ToolExecuteSettlement,
  state: StepExecutionState,
  call: ModelCall,
  chainOn: string | undefined,
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
  recordToolModelResult(state, call, settlement.modelResult, chainOn);
  if (settlement.pendingInject) {
    yield* applyStageInjects(state, 'post_tool', settlement.pendingInject, {
      callId: call.callId,
      toolName: call.name,
    });
  }
  return 'continue';
}

/**
 * Run the model's calls in order. Each reaches the host as its raw call first,
 * then its phases. A call that gates waits for its own approval; the step's
 * other calls still run. After the step, any gate stops the turn.
 */
async function* handleModelCalls(
  calls: ModelCall[],
  generation: ResolvedGeneration,
  profile: Profile,
  state: StepExecutionState,
  system: BoundSystem,
  { onStage, signal, credentials, resolveHost }: Partial<TurnRequest> = {},
): AsyncGenerator<TurnEvent, boolean> {
  const chainOn = chainedInteractionId(generation, state);
  if (!chainOn && calls.length > 0) {
    state.currentHistory.push(stepCallsMessage(calls));
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
  let gated = false;
  for (const call of calls) {
    yield announce(call);

    if (call.failure) {
      yield recordProviderToolFailure(state, call, call.failure, chainOn);
      continue;
    }

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

    const settlement = yield* forwardToolEvents(
      executeRegisteredTool({
        tools: state.tools,
        ...(state.agents ? { agents: state.agents } : {}),
        profile,
        name: call.name,
        input: call.arguments,
        callId: call.callId,
        ctx: {
          sessionPermissions: generation.sessionPermissions,
          path: generation.tools.path,
          turn: { step: state.stepCount, taint: state.taint, destinations: state.destinations },
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

    const outcome = yield* applyToolSettlement(settlement, state, call, chainOn);
    if (outcome === 'stop_cancelled') return false;
    if (outcome === 'gated') gated = true;
  }
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
    const stepResult = yield* executeAutonomousStep(
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
  }

  return { latestStructured };
}

export { executeAttempt };
