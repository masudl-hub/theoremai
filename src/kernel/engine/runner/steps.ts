import { throwIfAborted } from '../../../guardrails/error.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { sanitizeHistory } from '../../../guardrails/sanitize.ts';
import { recordTaint } from '../../../guardrails/tool-result.ts';
import { profileTurnOutputs } from '../../registry/profile-outputs.ts';
import { profileAllowsSteering } from '../../stop.ts';
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
  TurnSteerBarrier,
  TurnSteerHandler,
} from '../../types.ts';
import { recordStepEvent, type StepExecutionState } from './state.ts';
import { type OutboundStreamControl, yieldProviderEvents } from './stream.ts';

function isStepLimitReached(step: number, maxSteps: number): boolean {
  if (maxSteps === undefined || maxSteps <= 0) {
    return false;
  }
  return step >= maxSteps;
}

/** Sanitize host steer injects with the profile's untrusted-input policy. */
function sanitizeSteerInjects(
  profile: Profile,
  messages: TurnHistoryMessage[],
): TurnHistoryMessage[] {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  return sanitizeHistory(messages, detectionForTrust(policy, 'untrusted'));
}

/**
 * Move opening user `generation.input` into history so steer injects and tool
 * turns append after the user turn (Orchid absorb order).
 */
function foldGenerationInputIntoHistory(
  generation: ResolvedGeneration,
  state: StepExecutionState,
): void {
  if (state.foldedForGeneration === generation) return;
  state.foldedForGeneration = generation;
  if (generation.input.length === 0) return;
  const textOnly = generation.input.every((p) => p.type === 'text');
  if (textOnly) {
    state.currentHistory.push({
      role: 'user',
      content: generation.input.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    });
  } else {
    state.currentHistory.push({
      role: 'user',
      parts: [...generation.input],
    });
  }
  generation.input = [];
}

/**
 * Emit a barrier event and apply host `onSteer` injects into turn history.
 * No-op when the profile does not allow steering.
 */
async function* applySteerBarrier(args: {
  profile: Profile;
  generation: ResolvedGeneration;
  barrier: TurnSteerBarrier;
  step: number;
  state: StepExecutionState;
  onSteer?: TurnSteerHandler;
  signal?: AbortSignal;
}): AsyncGenerator<TurnEvent> {
  if (!profileAllowsSteering(args.profile)) return;
  throwIfAborted(args.signal);

  const event: TurnEvent = { type: 'barrier', barrier: args.barrier };
  args.state.allEmittedEvents.push(event);
  yield event;

  // Fold only when a host hook is present — otherwise keep the existing
  // history+input wire shape for non-steering turns.
  if (args.barrier === 'pre_llm' && args.onSteer) {
    foldGenerationInputIntoHistory(args.generation, args.state);
  }

  if (!args.onSteer) return;
  const result = await args.onSteer({
    barrier: args.barrier,
    step: args.step,
    history: args.state.currentHistory,
  });
  throwIfAborted(args.signal);
  const inject = result?.inject;
  if (!inject || inject.length === 0) return;
  const sanitized = sanitizeSteerInjects(args.profile, inject);
  args.state.currentHistory.push(...sanitized);
  // Interactions tool follow-ups use interactionOnlyInput and ignore history —
  // append user_input steps so steer injects still reach the provider.
  if (args.state.interactionsContinuation) {
    for (const msg of sanitized) {
      if (msg.role === 'tool') continue;
      args.state.interactionsContinuation.input.push(steerMessageToInteractionStep(msg));
    }
  }
}

/** Provider-neutral Interactions `user_input` / `model_output` step for a steer inject. */
function steerMessageToInteractionStep(msg: TurnHistoryMessage): Record<string, unknown> {
  const type = msg.role === 'assistant' ? 'model_output' : 'user_input';
  if (msg.parts && msg.parts.length > 0) {
    return {
      type,
      content: msg.parts.map((p) => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        return { type: p.type, mimeType: p.mimeType, data: p.data };
      }),
    };
  }
  return { type, content: [{ type: 'text', text: msg.content ?? '' }] };
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
        turn: { step: state.stepCount, taint: state.taint },
        credentials: safe?.credentials,
      },
      snapshot: generation.tools,
    });
    let next = await exec.next();
    while (!next.done) {
      const event = next.value;
      if (event.type !== 'tool') {
        // Guardrail decisions travel alongside tool events; enrichment would
        // rewrite them into tool-shaped events and lose them.
        state.allEmittedEvents.push(event);
        yield event;
        next = await exec.next();
        continue;
      }
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
      if (modelResult.provenance) {
        // Remote reads taint the turn for every tool call that follows.
        state.taint = recordTaint(state.taint, modelResult.provenance, modelResult.suspicious);
      }
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
  // Text/thought stream via progressive-yield under egress; validation and egress
  // both hold non-visible events (structured) until the attempt gate, so a policy
  // sees the structured payload before any of it reaches the host.
  const holdLate = Boolean(
    profileTurnOutputs(profile)?.validation ||
      resolveGuardrailPolicy(profile.guardrails).egress?.enforce,
  );

  while (!isStepLimitReached(stepInAttempt, generation.maxSteps ?? 0)) {
    throwIfAborted(args.safe.signal);
    stepInAttempt++;
    state.stepCount++;
    const barrier: TurnSteerBarrier = stepInAttempt === 1 ? 'pre_llm' : 'pre_tool_followup';
    yield* applySteerBarrier({
      profile,
      generation,
      barrier,
      step: state.stepCount,
      state,
      onSteer: args.safe.onSteer,
      signal: args.safe.signal,
    });
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
