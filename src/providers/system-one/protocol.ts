import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { defineProtocol } from '../../kernel/protocols/mod.ts';
import { jsonObjectSchema } from '../../kernel/provider-contract.ts';
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

/** TypeSafe's decision API: questions about a state, answered in one call. */
export const systemOne = defineProtocol({
  id: 'systemOne',
  name: 'System One',
  description: "TypeSafe's decision API: questions about a state, answered in one call.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { decision: '/systemone' },
  options: z.strictObject({}),
  create(context) {
    return {
      async decide(request) {
        const body = jsonObjectSchema.parse({
          model: context.apiId,
          state: request.state,
          questions: request.questions,
        });
        for await (const row of context.send(body, { stream: false })) {
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
