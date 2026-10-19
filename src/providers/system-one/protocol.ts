import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { jsonObjectSchema } from '../../kernel/json.ts';
import { defineProtocol, type Protocol } from '../../kernel/protocols/mod.ts';
import type { DecisionCall } from '../../kernel/protocols/protocol.ts';
import type { DecisionResult } from '../../kernel/types.ts';

const count = z.number().int().nonnegative();

const reply = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: count,
      output_tokens: count,
      cost: z.number().nonnegative().optional(),
    })
    .optional()
    .catch(undefined),
});

/** What a System One binding may set. Both are TypeSafe's opt-in "danger zone" headers. */
export interface SystemOneOptions {
  images?: boolean;
  longContext?: boolean;
}

const options: z.ZodType<SystemOneOptions> = z.strictObject({
  images: z.boolean().optional().describe(
    // labels-exempt: builder field description, read by the studio and docs
    'Let a decision hold images and box questions. TypeSafe calls this experimental, and a request that uses either is refused without it.',
  ),
  longContext: z.boolean().optional().describe(
    // labels-exempt: builder field description, read by the studio and docs
    'Raise the context window from 64k tokens to 262k. TypeSafe calls this slower and less accurate.',
  ),
});

const IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images';
const LONG_CONTEXT_HEADER = 'TypeSafe-Danger-Zone-Long-Context';

/** TypeSafe's decision API: questions about a state, answered in one call. */
export const systemOne: Protocol<SystemOneOptions> = defineProtocol({
  id: 'systemOne',
  name: 'System One',
  description: "TypeSafe's decision API: questions about a state, answered in one call.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { decision: '/systemone' },
  options,
  create(context) {
    return {
      async decide(request) {
        const asksBox = Object.values(request.questions).some(({ type }) => type === 'box');
        const holdsImages = asksBox || (request.assets && Object.keys(request.assets).length > 0);
        if (holdsImages && !context.options.images)
          throw new TheoremError('unsupported', labelText('provider.decision_images_off'));
        // why: Only a pinned 1.13 is known to refuse a box; aliases such as `jev-latest` move, so they pass.
        if (asksBox && /^jev-1\.13(\.|$)/.test(context.apiId))
          throw new TheoremError(
            'unsupported',
            labelText('provider.decision_box_model', { apiId: context.apiId }),
          );
        const headers: Record<string, string> = {};
        if (holdsImages) headers[IMAGES_HEADER] = 'true';
        if (context.options.longContext) headers[LONG_CONTEXT_HEADER] = 'true';
        const body = jsonObjectSchema.parse({
          model: context.apiId,
          state: request.state,
          questions: request.questions,
          ...(request.assets && Object.keys(request.assets).length
            ? { assets: assetsOnWire(request.assets) }
            : {}),
        });
        for await (const row of context.send(body, { stream: false, headers })) {
          const parsed = reply.safeParse(row);
          if (!parsed.success)
            throw new TheoremError(
              'bad_response',
              labelText('protocol.reply_shape', {
                protocol: 'systemOne',
                issues: z.prettifyError(parsed.error),
              }),
            );
          const { model, answers, usage } = parsed.data;
          // invariant: The kernel validates every answer against its question before exposing it.
          return {
            model,
            answers: answers as DecisionResult['answers'],
            ...(usage
              ? {
                  usage: {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    ...(usage.cost === undefined ? {} : { costUsd: usage.cost }),
                  },
                }
              : {}),
          };
        }
        throw new TheoremError('bad_response', labelText('provider.decision_failed'));
      },
    };
  },
});

const FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg' } as const;

function assetsOnWire(assets: NonNullable<DecisionCall['assets']>) {
  return Object.fromEntries(
    Object.entries(assets).map(([reference, { mimeType, data }]) => [
      reference,
      { type: 'image', format: FORMATS[mimeType], data_base64: data },
    ]),
  );
}
