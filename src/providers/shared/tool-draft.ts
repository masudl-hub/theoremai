import type { ModelEvent } from '../../kernel/types.ts';

/** A tool call a provider is streaming: its id and name as far as they have come, and its arguments' text. */
export interface StreamingToolCall {
  id?: string;
  name: string;
  args: string;
  /** How much of `args` has gone out as `tool_draft` events. */
  drafted?: number;
}

/**
 * The `tool_draft` event for what `call.args` has gained since it last drafted, and advances
 * `call.drafted`. Nothing until the call has an id and a name: the call is emitted under that id,
 * and its draft is joined to it by that id alone. Whatever came before then goes out in the first
 * draft.
 */
export function toolDraftEvents(call: StreamingToolCall): ModelEvent[] {
  const name = call.name.trim();
  const from = call.drafted ?? 0;
  if (!(call.id && name) || call.args.length <= from) return [];
  call.drafted = call.args.length;
  return [{ type: 'tool_draft', callId: call.id, name, text: call.args.slice(from) }];
}
