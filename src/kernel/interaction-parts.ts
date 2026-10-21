import type { InteractionMediaRefPart, InteractionPart, TurnHistoryMessage } from './types.ts';

/** `toGoogleValue` snake-cases `mimeType` to the documented Interactions `mime_type`. */
export function wireInteractionPart(part: InteractionPart): Record<string, string> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if ('uri' in part) {
    return { type: part.type, mimeType: part.mimeType, uri: part.uri };
  }
  return { type: part.type, mimeType: part.mimeType, data: part.data };
}

/** True for a part that is media referenced by `uri` rather than carried as data. */
export function isMediaRefPart(part: InteractionPart): part is InteractionMediaRefPart {
  return part.type !== 'text' && 'uri' in part;
}

/**
 * Everything a history message says, in the one order every provider adapter
 * sends it: `content` first as a text part (when non-empty), then `parts`.
 * Neither field replaces the other.
 */
export function historyMessageParts(msg: TurnHistoryMessage): InteractionPart[] {
  const parts = msg.parts ?? [];
  return msg.content ? [{ type: 'text', text: msg.content }, ...parts] : [...parts];
}

/**
 * One model call's reply as the model reads it back later in its turn: what it
 * wrote (its structured reply, when it gave one), then the calls it made. Turn
 * history and a provider checkpoint both build it here, so the checkpoint
 * covers exactly the history the turn's next call sends.
 */
export function stepReplyMessages(reply: {
  text: string;
  structured?: unknown;
  calls: Parameters<typeof historyToolCalls>[0];
}): TurnHistoryMessage[] {
  const content = reply.structured !== undefined ? JSON.stringify(reply.structured) : reply.text;
  return [
    ...(content ? [{ role: 'assistant' as const, content }] : []),
    ...(reply.calls.length ? [historyToolCalls(reply.calls)] : []),
  ];
}

/** One step's calls as the assistant message that made them, with the reasoning written before them. */
function historyToolCalls(
  calls: readonly Pick<
    import('./turn-events.ts').ToolCallRequest,
    'callId' | 'name' | 'arguments' | 'reasoning'
  >[],
): TurnHistoryMessage {
  const reasoning = calls.flatMap((call) => call.reasoning ?? []);
  const tool_calls: NonNullable<TurnHistoryMessage['tool_calls']> = [];
  for (const call of calls) {
    tool_calls.push({
      id: call.callId,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    });
  }
  return {
    role: 'assistant',
    tool_calls,
    ...(reasoning.length ? { reasoning: [...reasoning] } : {}),
  };
}
