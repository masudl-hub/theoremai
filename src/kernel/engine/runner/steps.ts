import { throwIfAborted } from '../../../guardrails/error.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import {
  executeRegisteredTool,
  formatToolFailureForModel,
  formatToolResult,
  newCallId,
} from '../../tools/execute.ts';
import type { ModelToolResult } from '../../tools/types.ts';
import type {
  ModelProvider,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../types.ts';
import { recordStepEvent, type StepExecutionState } from './state.ts';
import { type OutboundStreamControl, yieldProviderEvents } from './stream.ts';

function isStepLimitReached(step: number, maxSteps: number): boolean {
  if (maxSteps === undefined || maxSteps <= 0) {
    return false;
  }
  return step >= maxSteps;
}

function generationForProviderStep(
  generation: ResolvedGeneration,
  state: StepExecutionState,
): ResolvedGeneration {
  if (state.interactionsContinuation) {
    const { previousInteractionId, input } = state.interactionsContinuation;
    state.interactionsContinuation = undefined;
    return {
      ...generation,
      history: [],
      input: [],
      previousInteractionId,
      interactionOnlyInput: input,
    };
  }
  return { ...generation, history: state.currentHistory };
}

function captureInteractionId(event: TurnEvent, state: StepExecutionState): void {
  if (event.interactionId) {
    state.lastInteractionId = event.interactionId;
  }
}

async function* executeAutonomousStep(
  args: {
    profile: Profile;
    generation: ResolvedGeneration;
    system: string;
    provider: ModelProvider;
    upstream: Record<string, unknown>[];
    signal?: AbortSignal;
  },
  state: StepExecutionState,
  buffer: { holdLate: boolean } = {
    holdLate: false,
  },
): AsyncGenerator<TurnEvent, { pendingTools: TurnEvent[]; latestStructured?: unknown }> {
  const { generation, system, provider, upstream, signal } = args;
  const genForStep = generationForProviderStep(generation, state);
  const pendingTools: TurnEvent[] = [];
  let latestStructured: unknown;
  const control: OutboundStreamControl = { withholdVisible: false };

  for await (const event of yieldProviderEvents({
    profile: args.profile,
    generation: genForStep,
    system,
    provider,
    upstream,
    signal,
    control,
  })) {
    captureInteractionId(event, state);
    if (event.type === 'structured') {
      latestStructured = event.structured;
    }
    if (event.type === 'done') {
      if (event.stop) {
        state.lastStop = event.stop;
      }
      continue;
    }
    if (event.type === 'tool' && event.tool) {
      pendingTools.push(event);
      continue;
    }
    recordStepEvent(event, state);
    const isUserVisible =
      event.type === 'thought' || event.type === 'text' || event.type === 'media';
    if (control.withholdVisible && isUserVisible) {
      // Progressive-yield blocked this attempt — keep events for egress/repair only.
      continue;
    }
    // Progressive-yield streams text/thought live under egress; holdLate only
    // buffers non-visible events (e.g. structured) for validation.
    const streamNow = !buffer.holdLate || event.type === 'tokens' || isUserVisible;
    if (streamNow) {
      yield event;
    }
  }

  return { pendingTools, latestStructured };
}

function appendInteractionsToolResultToHistory(
  history: TurnHistoryMessage[],
  toolEv: TurnEvent,
  result: ModelToolResult,
): void {
  const tool = toolEv.tool;
  if (!tool) {
    return;
  }
  history.push({
    role: 'tool',
    tool_call_id: tool.id ?? tool.callId ?? `call_${tool.name}`,
    name: tool.name,
    content: formatToolResult(result),
  });
}

function appendToolTurnToHistory(
  history: TurnHistoryMessage[],
  toolEv: TurnEvent,
  result: ModelToolResult,
): void {
  const tool = toolEv.tool;
  if (!tool) {
    return;
  }
  const callId = tool.id ?? tool.callId ?? newCallId(tool.name);
  history.push({
    role: 'assistant',
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: {
          name: tool.name,
          arguments: JSON.stringify(tool.arguments ?? {}),
        },
      },
    ],
  });
  history.push({
    role: 'tool',
    tool_call_id: callId,
    name: tool.name,
    content: formatToolResult(result),
  });
}

function queueInteractionsToolContinuation(
  state: StepExecutionState,
  toolEv: TurnEvent,
  result: ModelToolResult,
  fallbackInteractionId?: string,
): void {
  const tool = toolEv.tool;
  if (!tool) {
    return;
  }
  const previousInteractionId = state.lastInteractionId ?? fallbackInteractionId;
  if (!previousInteractionId) {
    return;
  }
  const step = {
    type: 'function_result',
    name: tool.name,
    call_id: tool.id ?? tool.callId ?? `call_${tool.name}`,
    result: [{ type: 'text', text: formatToolResult(result) }],
  };
  if (
    state.interactionsContinuation &&
    state.interactionsContinuation.previousInteractionId === previousInteractionId
  ) {
    state.interactionsContinuation.input.push(step);
    return;
  }
  state.interactionsContinuation = {
    previousInteractionId,
    input: [step],
  };
}

function recordToolModelResult(
  state: StepExecutionState,
  toolEv: TurnEvent,
  modelResult: ModelToolResult,
  generation: ResolvedGeneration,
  useInteractionsContinuation: boolean,
): void {
  if (useInteractionsContinuation) {
    queueInteractionsToolContinuation(state, toolEv, modelResult, generation.previousInteractionId);
    if (!state.interactionsContinuation) {
      appendInteractionsToolResultToHistory(state.currentHistory, toolEv, modelResult);
    }
    return;
  }
  appendToolTurnToHistory(state.currentHistory, toolEv, modelResult);
}

function enrichToolEvent(
  tool: NonNullable<TurnEvent['tool']>,
  callId: string,
  patch?: Partial<NonNullable<TurnEvent['tool']>>,
): TurnEvent {
  return {
    type: 'tool',
    tool: {
      ...tool,
      ...patch,
      callId,
      id: tool.id ?? callId,
    },
  };
}

async function* handlePendingTools(
  pendingTools: TurnEvent[],
  generation: ResolvedGeneration,
  profile: Profile,
  state: StepExecutionState,
  safe?: TurnRequest,
): AsyncGenerator<TurnEvent, boolean> {
  let executed = false;
  let sawPause = false;
  const useInteractionsContinuation = generation.transport === 'interactions';
  for (const toolEv of pendingTools) {
    const tool = toolEv.tool;
    if (!tool) {
      continue;
    }

    executed = true;
    const callId = tool.id ?? tool.callId ?? newCallId(tool.name || 'unknown');

    // Provider cancelled an in-flight call (e.g. live barge-in). Do not execute.
    if (tool.phase === 'cancel') {
      const enriched = enrichToolEvent(tool, callId);
      state.allEmittedEvents.push(enriched);
      yield enriched;
      continue;
    }

    // Provider already failed this call (e.g. malformed arguments JSON).
    if (tool.phase === 'error' && tool.failure) {
      const enriched = enrichToolEvent(tool, callId);
      state.allEmittedEvents.push(enriched);
      yield enriched;
      recordToolModelResult(
        state,
        toolEv,
        formatToolFailureForModel(tool.failure),
        generation,
        useInteractionsContinuation,
      );
      continue;
    }

    // Empty name is a protocol defect — never route through the registry as unknown_tool.
    if (!tool.name) {
      const failure = {
        code: 'malformed_arguments',
        message: 'Provider tool call is missing a function name',
      };
      const enriched = enrichToolEvent(tool, callId, {
        phase: 'error',
        failure,
        name: '',
      });
      state.allEmittedEvents.push(enriched);
      yield enriched;
      recordToolModelResult(
        state,
        toolEv,
        formatToolFailureForModel(failure),
        generation,
        useInteractionsContinuation,
      );
      continue;
    }

    let modelResult: ModelToolResult | undefined;
    let paused = false;
    const exec = executeRegisteredTool({
      profile,
      name: tool.name,
      input: tool.arguments ?? {},
      callId,
      ctx: {
        sessionPermissions: generation.sessionPermissions,
        path: generation.tools.path,
        turn: { step: state.stepCount },
        credentials: safe?.credentials,
      },
      snapshot: generation.tools,
    });
    let next = await exec.next();
    while (!next.done) {
      const event = next.value;
      const enriched = enrichToolEvent(tool, callId, event.tool);
      state.allEmittedEvents.push(enriched);
      yield enriched;
      if (event.tool?.phase === 'error' && event.tool.failure) {
        modelResult = formatToolFailureForModel(event.tool.failure);
      }
      if (event.tool?.phase === 'pause') {
        modelResult = undefined;
        paused = true;
      }
      next = await exec.next();
    }
    if (next.value !== undefined) {
      modelResult = next.value;
    }
    if (paused) {
      sawPause = true;
      state.toolSnapshot = generation.tools;
      continue;
    }
    if (!modelResult) {
      continue;
    }
    recordToolModelResult(state, toolEv, modelResult, generation, useInteractionsContinuation);
  }
  if (sawPause) {
    state.lastStop = { kind: 'tool' };
    return false;
  }
  return executed;
}

async function* executeAttempt(args: {
  safe: TurnRequest;
  profile: Profile;
  generation: ResolvedGeneration;
  system: string;
  provider: ModelProvider;
  upstream: Record<string, unknown>[];
  state: StepExecutionState;
}): AsyncGenerator<TurnEvent, { pendingTools: TurnEvent[]; latestStructured?: unknown }> {
  const { profile, generation, system, provider, upstream, state } = args;
  let latestStructured: unknown;
  let pendingTools: TurnEvent[] = [];
  let stepInAttempt = 0;
  // Text/thought stream via progressive-yield under egress; validation still
  // holds non-visible events (structured) until the attempt gate.
  const holdLate = Boolean(profileTurnOutputs(profile)?.validation);

  while (!isStepLimitReached(stepInAttempt, generation.maxSteps ?? 0)) {
    throwIfAborted(args.safe.signal);
    stepInAttempt++;
    state.stepCount++;
    const stepResult = yield* executeAutonomousStep(
      { profile, generation, system, provider, upstream, signal: args.safe.signal },
      state,
      { holdLate },
    );
    if (stepResult.latestStructured !== undefined) {
      latestStructured = stepResult.latestStructured;
    }
    pendingTools = stepResult.pendingTools;

    if (pendingTools.length === 0) {
      break;
    }

    const executed = yield* handlePendingTools(pendingTools, generation, profile, state, args.safe);
    if (!executed) {
      break;
    }
  }

  return { pendingTools, latestStructured };
}

export { executeAttempt };
