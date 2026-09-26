/**
 * A turn's tool calls, joined by `callId`: the model's raw call (the one owner
 * of its arguments) and the phase events of its execution. The transcript,
 * the interface session and history read calls through this fold only.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import type { ToolCallEvent, TurnEvent } from '../kernel/types.ts';
import type { ToolCall } from './types.ts';

/**
 * Fold one tool event into its call. The raw call comes first for every call
 * (`turnEventSchema`); a phase for a call never made is a broken stream.
 */
function applyToolEvent(call: ToolCall | undefined, tool: ToolCallEvent): ToolCall {
  if (tool.phase === undefined) {
    return {
      name: tool.name,
      callId: tool.callId,
      arguments: tool.arguments,
      ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}),
      ...(tool.stepId ? { stepId: tool.stepId } : {}),
      artifacts: [],
    };
  }
  if (call === undefined) {
    throw new TheoremError(
      'bad_response',
      `Tool event '${tool.phase}' for call '${tool.callId}' arrived before the call.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  switch (tool.phase) {
    case 'running': {
      // A resumed call runs again: it is open until its next settle.
      const { endedAt: _settled, ...open } = call;
      return {
        ...open,
        state: tool,
        startedAt: tool.at,
        ...(tool.edited ? { edited: tool.edited } : {}),
      };
    }
    case 'complete':
    case 'error':
    case 'cancel':
    case 'gate':
      return { ...call, state: tool, endedAt: tool.at };
    case 'artifact':
      return { ...call, artifacts: [...call.artifacts, tool.artifact] };
    case 'progress':
    case 'trace':
    case 'warning':
      return call;
  }
}

/** Every call in `events`, in the order the model made them. */
function toolCallsOf(events: readonly TurnEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type !== 'tool') continue;
    const { tool } = event;
    calls.set(tool.callId, applyToolEvent(calls.get(tool.callId), tool));
  }
  return [...calls.values()];
}

/** The arguments a call ran with: the user's edit, else the model's. */
function toolCallRanWith(call: ToolCall): Record<string, unknown> {
  return call.edited?.to ?? call.arguments;
}

export { applyToolEvent, toolCallRanWith, toolCallsOf };
