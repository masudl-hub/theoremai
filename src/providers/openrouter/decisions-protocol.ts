import { z } from 'zod';
import { type JsonObject, type JsonValue, jsonObjectSchema } from '../../kernel/json.ts';
import { defineProtocol, type Protocol } from '../../kernel/protocols/mod.ts';
import type { DecisionCall } from '../../kernel/protocols/protocol.ts';
import { decisionAnswered } from '../system-one/protocol.ts';

type Assets = NonNullable<DecisionCall['assets']>;

/**
 * OpenRouter's decision API: questions about a state, answered in one call. It takes no options:
 * images and box questions need no opt-in, and a request with an image runs in long context.
 */
export const openRouterDecisions: Protocol<Record<string, never>> = defineProtocol({
  id: 'openRouterDecisions',
  name: 'OpenRouter Decisions',
  description: "OpenRouter's decision API: questions about a state, answered in one call.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { decision: '/alpha/decisions' },
  options: z.strictObject({}),
  create(context) {
    return {
      decide(request) {
        const assets = request.assets ?? {};
        const body = jsonObjectSchema.parse({
          model: context.apiId,
          state: withImages(request.state, assets),
          questions: Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              {
                ...question,
                instructions: withImages(question.instructions, assets),
                ...('criteria' in question && question.criteria !== undefined
                  ? { criteria: withImages(question.criteria as JsonValue, assets) }
                  : {}),
              },
            ]),
          ),
        });
        return decisionAnswered('openRouterDecisions', context.send(body, { stream: false }));
      },
    };
  },
});

/**
 * Each reference becomes the reference followed by its image, where the reference was.
 * why: OpenRouter ignores an `assets` map; it reads image parts in place.
 */
function withImages(value: JsonValue, assets: Assets): JsonValue {
  if (typeof value === 'string') {
    const asset = assets[value];
    return asset
      ? [
          value,
          { type: 'image_url', image_url: { url: `data:${asset.mimeType};base64,${asset.data}` } },
        ]
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => withImages(item, assets));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withImages(item, assets)]),
    ) as JsonObject;
  return value;
}
