// invariant: The model's raw call is the one owner of a call's arguments. The transcript, the interface
// session and history read calls through this fold only.

import { TheoremError } from '../guardrails/error.ts';
import { labelText } from '../guardrails/labels.ts';
import { turnEventSchema } from '../kernel/turn-events.ts';
import type { ToolCallEvent, TurnEvent, TurnEventOf } from '../kernel/types.ts';
import { partialJsonObject } from '../kernel/util/partial-json.ts';
import type { ToolCall } from './types.ts';

/**
 * The raw call comes first for every call (`turnEventSchema`); a phase for a call never made is a
 * broken stream.
 */
function applyToolEvent(call: ToolCall | undefined, tool: ToolCallEvent): ToolCall {
  if (tool.phase === undefined) {
    return {
      name: tool.name,
      callId: tool.callId,
      ...(tool.operationId ? { operationId: tool.operationId } : {}),
      arguments: tool.arguments,
      ...(tool.reasoning ? { reasoning: tool.reasoning } : {}),
      ...(tool.stepId ? { stepId: tool.stepId } : {}),
      artifacts: [],
    };
  }
  if (call === undefined) {
    throw new TheoremError(
      'bad_response',
      `Tool event '${tool.phase}' for call '${tool.callId}' arrived before the call.`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (call.callId !== tool.callId || call.name !== tool.name) {
    throw new TheoremError('bad_response', labelText('error.bad_response'));
  }
  switch (tool.phase) {
    case 'running': {
      // why: A resumed call runs again: it is open until its next settle.
      const { endedAt: _settled, outputDraft: _drafted, ...open } = call;
      return {
        ...open,
        state: tool,
        startedAt: tool.at,
        ...(tool.edited ? { edited: tool.edited } : {}),
        ...(tool.activity ? { activity: tool.activity } : {}),
      };
    }
    case 'complete':
      return {
        ...settled(call),
        state: tool,
        endedAt: tool.at,
        ...(tool.activityPast ? { activityPast: tool.activityPast } : {}),
      };
    case 'error':
      return {
        ...settled(call),
        state: tool,
        endedAt: tool.at,
        ...(tool.activityPast ? { activityPast: tool.activityPast } : {}),
      };
    case 'cancel':
    case 'gate':
      return { ...settled(call), state: tool, endedAt: tool.at };
    case 'draft':
      return { ...call, outputDraft: (call.outputDraft ?? '') + tool.text };
    case 'artifact':
      return { ...call, artifacts: [...call.artifacts, tool.artifact] };
    case 'progress':
      return withAgentStep(call, tool.data);
    case 'dispatch':
    case 'trace':
    case 'warning':
      return call;
  }
}

/** `call` without the preview of its output: it settled, and its output is whole. */
function settled(call: ToolCall): ToolCall {
  const { outputDraft: _drafted, ...rest } = call;
  return rest;
}

/**
 * A call the model is still writing, with the next piece of its draft added. The call that arrives
 * whole replaces it (`applyToolEvent` builds the call from the request alone).
 */
function applyToolDraft(call: ToolCall | undefined, draft: TurnEventOf<'tool_draft'>): ToolCall {
  return {
    arguments: {},
    artifacts: [],
    ...call,
    name: draft.name,
    callId: draft.callId,
    draft: (call?.draft ?? '') + draft.text,
  };
}

type ToolCallEventOf = TurnEventOf<'tool'> | TurnEventOf<'tool_draft'>;

/** Adds one call event to `calls`, keyed as `toolCallsOf` keys them. */
function foldToolCall(calls: Map<string, ToolCall>, event: ToolCallEventOf): void {
  if (event.type === 'tool_draft') {
    calls.set(event.callId, applyToolDraft(calls.get(event.callId), event));
    return;
  }
  const { tool } = event;
  const key = tool.operationId ?? tool.callId;
  // why: The draft is keyed by the model's callId; the call that replaces it may carry an operation ID.
  if (tool.phase === undefined && calls.get(tool.callId)?.draft !== undefined) {
    calls.delete(tool.callId);
  }
  calls.set(key, applyToolEvent(calls.get(key), tool));
}

/** Every call in `events`, in the order the model made them. */
function toolCallsOf(events: readonly TurnEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type === 'tool_draft' || event.type === 'tool') foldToolCall(calls, event);
  }
  return [...calls.values()];
}

/**
 * A call event of the agent an agent tool ran, which the kernel carries as the call's progress
 * (`{ agent, event }`); any other progress is not a step.
 */
function agentStep(data: unknown): ToolCallEventOf | undefined {
  if (typeof data !== 'object' || data === null || !('agent' in data) || !('event' in data)) {
    return undefined;
  }
  const { event } = data as { event: { type?: unknown } | null };
  if (event?.type !== 'tool' && event?.type !== 'tool_draft') return undefined;
  const parsed = turnEventSchema.safeParse(event);
  return parsed.success ? (parsed.data as ToolCallEventOf) : undefined;
}

/** `call` with the agent step its progress carries, if it carries one that fits. */
function withAgentStep(call: ToolCall, data: unknown): ToolCall {
  const step = agentStep(data);
  const steps = step && withStep(call.steps ?? [], step);
  return steps ? { ...call, steps } : call;
}

/**
 * `steps` with one more agent step folded in, or `undefined` when it does not fit.
 * why: A step is progress, not the stream itself: one that does not fit its call is dropped, so it
 * never breaks the transcript of the call that carries it.
 */
function withStep(steps: readonly ToolCall[], event: ToolCallEventOf): ToolCall[] | undefined {
  const calls = new Map(steps.map((step) => [step.operationId ?? step.callId, step]));
  if (event.type === 'tool' && event.tool.phase !== undefined) {
    const known = calls.get(event.tool.operationId ?? event.tool.callId);
    if (known?.callId !== event.tool.callId || known.name !== event.tool.name) return undefined;
  }
  foldToolCall(calls, event);
  return [...calls.values()];
}

/** The arguments shown for approval, or the user's edit, or the model's original call. */
function toolCallRanWith(call: ToolCall): Record<string, unknown> {
  return (
    (call.state?.phase === 'gate' ? call.state.gate.preparedArguments : undefined) ??
    call.edited?.to ??
    call.arguments
  );
}

/** A tool event that settles its call: the call completed or failed. */
type SettledToolCallEvent = TurnEventOf<'tool'> & {
  tool: Extract<ToolCallEvent, { phase: 'complete' | 'error' }>;
};

/** True when the event is the complete or error event of the tool call with this id. */
function settlesToolCall(event: TurnEvent, callId: string): event is SettledToolCallEvent {
  if (event.type !== 'tool' || event.tool.callId !== callId) return false;
  return event.tool.phase === 'complete' || event.tool.phase === 'error';
}

/**
 * A call's arguments as far as the model has written them: the whole arguments once the call has
 * arrived, else what `partialJsonObject` reads of its draft. For a preview: a field still being
 * written is not its final value.
 */
function argumentsSoFar(call: ToolCall): Record<string, unknown> {
  return call.draft === undefined ? call.arguments : partialJsonObject(call.draft);
}

export type { SettledToolCallEvent };
export {
  applyToolDraft,
  applyToolEvent,
  argumentsSoFar,
  settlesToolCall,
  toolCallRanWith,
  toolCallsOf,
};
