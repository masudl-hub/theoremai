import { type JsonObject, jsonObjectSchema } from '../../../kernel/json.ts';
import { isRecord } from '../../../kernel/util/record.ts';

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
