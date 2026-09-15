import { throwIfAborted } from '../../../guardrails/error.ts';
import { resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { recordTaint } from '../../../guardrails/tool-result.ts';
import { wireInteractionPart } from '../../interaction-parts.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { profileAllowsInject } from '../../stop.ts';
import type { ToolExecuteSettlement } from '../../tools/execute.ts';
import {
  executeRegisteredTool,
  formatToolFailureForModel,
  formatToolResult,
  newCallId,
  type ToolStageSupport,
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
import { applyStageInjects, injectWouldExceedMaxSteps } from './stages.ts';
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
      // Record the decision so the attempt gate knows nothing reached the host.
      state.withheldVisible = true;
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
    ...(result.parts && result.parts.length > 0 ? { parts: result.parts } : {}),
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
    ...(result.parts && result.parts.length > 0 ? { parts: result.parts } : {}),
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
    result:
      result.parts && result.parts.length > 0
        ? result.parts.map(wireInteractionPart)
        : [{ type: 'text', text: formatToolResult(result) }],
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

async function* drainToolExecEvents(
  exec: AsyncGenerator<TurnEvent, ToolExecuteSettlement>,
  tool: NonNullable<TurnEvent['tool']>,
  callId: string,
  state: StepExecutionState,
): AsyncGenerator<TurnEvent, { settlement: ToolExecuteSettlement; sawGate: boolean }> {
  let next = await exec.next();
  let sawGate = false;
  while (!next.done) {
    const event = next.value;
    if (event.type === 'tool') {
      const enriched = enrichToolEvent(tool, callId, event.tool);
      state.allEmittedEvents.push(enriched);
      yield enriched;
      if (event.tool?.phase === 'gate') sawGate = true;
    } else {
      state.allEmittedEvents.push(event);
      yield event;
    }
    next = await exec.next();
  }
  return { settlement: next.value, sawGate };
}

function recordProviderToolFailure(
  state: StepExecutionState,
  toolEv: TurnEvent,
  tool: NonNullable<TurnEvent['tool']>,
  callId: string,
  failure: { code: string; message: string },
  generation: ResolvedGeneration,
  useInteractionsContinuation: boolean,
  patch?: Partial<NonNullable<TurnEvent['tool']>>,
): TurnEvent {
  const enriched = enrichToolEvent(tool, callId, {
    phase: 'error',
    failure,
    ...patch,
  });
  state.allEmittedEvents.push(enriched);
  recordToolModelResult(
    state,
    toolEv,
    formatToolFailureForModel(failure),
    generation,
    useInteractionsContinuation,
  );
  return enriched;
}

function applyToolSettlement(
  settlement: ToolExecuteSettlement,
  state: StepExecutionState,
  toolEv: TurnEvent,
  generation: ResolvedGeneration,
  profile: Profile,
  useInteractionsContinuation: boolean,
): 'continue' | 'stop_cancelled' | 'gated' {
  if (settlement.aborted) {
    state.lastStop = {
      kind: 'cancelled',
      ...(typeof settlement.aborted === 'object' && settlement.aborted.reason
        ? { native: settlement.aborted.reason }
        : {}),
    };
    return 'stop_cancelled';
  }
  if (settlement.gated) {
    state.toolSnapshot = generation.tools;
    return 'gated';
  }
  if (settlement.modelResult?.provenance) {
    state.taint = recordTaint(
      state.taint,
      settlement.modelResult.provenance,
      settlement.modelResult.suspicious,
    );
  }
  if (!settlement.modelResult) return 'continue';
  recordToolModelResult(
    state,
    toolEv,
    settlement.modelResult,
    generation,
    useInteractionsContinuation,
  );
  if (settlement.pendingInject?.length) {
    applyStageInjects(state, profile, settlement.pendingInject);
  }
  return 'continue';
}

async function* handlePendingTools(
  pendingTools: TurnEvent[],
  generation: ResolvedGeneration,
  profile: Profile,
  state: StepExecutionState,
  safe?: TurnRequest,
): AsyncGenerator<TurnEvent, boolean> {
  let executed = false;
  let sawGate = false;
  const useInteractionsContinuation = generation.transport === 'interactions';
  for (const toolEv of pendingTools) {
    if (sawGate) break;
    const tool = toolEv.tool;
    if (!tool) continue;

    executed = true;
    const callId = tool.id ?? tool.callId ?? newCallId(tool.name || 'unknown');

    if (tool.phase === 'cancel') {
      const enriched = enrichToolEvent(tool, callId);
      state.allEmittedEvents.push(enriched);
      yield enriched;
      continue;
    }

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

    if (!tool.name) {
      yield recordProviderToolFailure(
        state,
        toolEv,
        tool,
        callId,
        {
          code: 'malformed_arguments',
          message: 'Provider tool call is missing a function name', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        },
        generation,
        useInteractionsContinuation,
        { name: '' },
      );
      continue;
    }

    const stages: ToolStageSupport = {
      handlers: safe?.onStage ? [safe.onStage] : [],
      step: state.stepCount,
      history: () => state.currentHistory,
      injectAllowed: profileAllowsInject(profile),
      injectWouldExceedMaxSteps: injectWouldExceedMaxSteps(state.stepCount, generation.maxSteps),
      host: generation.host,
      signal: safe?.signal,
    };

    const drained = yield* drainToolExecEvents(
      executeRegisteredTool({
        profile,
        name: tool.name,
        input: tool.arguments ?? {},
        callId,
        ctx: {
          sessionPermissions: generation.sessionPermissions,
          path: generation.tools.path,
          turn: { step: state.stepCount, taint: state.taint },
          credentials: safe?.credentials,
          host: generation.host,
          resume: undefined,
          signal: safe?.signal,
        },
        snapshot: generation.tools,
        stages,
      }),
      tool,
      callId,
      state,
    );

    if (drained.sawGate) sawGate = true;
    const outcome = applyToolSettlement(
      drained.settlement,
      state,
      toolEv,
      generation,
      profile,
      useInteractionsContinuation,
    );
    if (outcome === 'stop_cancelled') return false;
    if (outcome === 'gated' || sawGate) {
      sawGate = true;
    }
  }
  if (sawGate) {
    state.lastStop = { kind: 'gate' };
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
  // Text/thought stream via progressive-yield under egress; validation and egress
  // both hold non-visible events (structured) until the attempt gate, so a policy
  // sees the structured payload before any of it reaches the host.
  const holdLate = Boolean(
    profileTurnOutputs(profile)?.validation ||
      resolveGuardrailPolicy(profile.guardrails).egress?.enforce,
  );

  // Ceiling is cumulative `state.stepCount` across before_end inject re-entries
  // within this attempt. Validation/egress repair resets stepCount at the start
  // of each attempt cycle (see gates.ts).
  while (!isStepLimitReached(state.stepCount, generation.maxSteps ?? 0)) {
    throwIfAborted(args.safe.signal);
    state.stepCount++;
    // Mid-loop inject lives on `post_tool` (after tools). Opening inject is `pre_turn`
    // outside this loop.
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
