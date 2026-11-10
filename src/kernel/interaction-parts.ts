import type { ToolCallRequest } from './turn-events.ts';
import type { InteractionMediaRefPart, InteractionPart, TurnHistoryMessage } from './types.ts';

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
 * One model call's reply as the model reads it back later in its turn: one
 * assistant message with what it wrote (its structured reply, when it gave
 * one), the calls it made, and the reasoning it wrote with them. Every API
 * takes a reply this way, as one message; split in two, the words read as a
 * reply already finished, and the model writes them again. Turn history, a
 * provider checkpoint, a live session, and a client's history all build it
 * here, so the checkpoint covers exactly the history the turn's next call sends.
 */
export function stepReplyMessages(reply: {
  text: string;
  structured?: unknown;
  calls: readonly Pick<ToolCallRequest, 'callId' | 'name' | 'arguments' | 'reasoning'>[];
}): TurnHistoryMessage[] {
  const content = reply.structured !== undefined ? JSON.stringify(reply.structured) : reply.text;
  if (!content && reply.calls.length === 0) return [];
  const reasoning = reply.calls.flatMap((call) => call.reasoning ?? []);
  const tool_calls = reply.calls.map((call) => ({
    id: call.callId,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  return [
    {
      role: 'assistant',
      ...(content ? { content } : {}),
      ...(tool_calls.length ? { tool_calls } : {}),
      ...(reasoning.length ? { reasoning } : {}),
    },
  ];
}
