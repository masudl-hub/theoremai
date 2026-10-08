import { z } from 'zod';
import type { JsonObject } from '../../../kernel/provider-contract.ts';
import { jsonObjectSchema } from '../../../kernel/provider-contract.ts';
import { isRecord } from '../../../kernel/util/record.ts';

export const reasoningStateSchema: z.ZodType<ReasoningState> = z.strictObject({
  replay: z.array(
    z.strictObject({
      callIds: z.array(z.string().min(1)).min(1),
      details: z.array(jsonObjectSchema).optional(),
      content: z.string().optional(),
    }),
  ),
});
export interface ReasoningState {
  replay: { callIds: string[]; details?: JsonObject[]; content?: string }[];
}
export function applyReasoningReplay(messages: Record<string, unknown>[], raw: unknown): void {
  if (raw === undefined) return;
  const state = reasoningStateSchema.parse(raw);
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    const ids = message.tool_calls.map((call) => (isRecord(call) ? call.id : undefined));
    const replay = state.replay.find(
      (record) =>
        record.callIds.length === ids.length &&
        record.callIds.every((id, index) => id === ids[index]),
    );
    if (!replay) continue;
    if (replay.details) message.reasoning_details = replay.details;
    if (replay.content) message.reasoning = replay.content;
  }
}
export function collectReasoning(
  row: Record<string, unknown>,
  details: Map<string, JsonObject>,
): string {
  let content = '';
  for (const choice of Array.isArray(row.choices) ? row.choices : []) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : undefined;
    if (!delta) continue;
    if (typeof delta.reasoning === 'string') content += delta.reasoning;
    else if (typeof delta.reasoning_content === 'string') content += delta.reasoning_content;
    for (const raw of Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []) {
      const detail = jsonObjectSchema.parse(raw);
      const key = JSON.stringify([detail.index ?? detail.id ?? details.size, detail.type]);
      const previous = details.get(key);
      const merged = { ...previous, ...detail };
      for (const field of ['text', 'summary', 'data'])
        if (previous && typeof previous[field] === 'string' && typeof detail[field] === 'string')
          merged[field] = previous[field] + detail[field];
      details.set(key, merged);
    }
  }
  return content;
}
