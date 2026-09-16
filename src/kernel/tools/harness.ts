/**
 * Built-in harness tools registered with THEORUM.
 *
 * @module
 */

import { z } from 'zod';
import { AWAITING_USER_INPUT_STATUS } from '../schema.ts';
import { registerTool } from './registry.ts';

const AskInputSchema = z.object({
  kind: z.enum(['confirm', 'choice', 'text']),
  prompt: z.string().trim().min(1),
  options: z.array(z.string()).optional(),
});

const AskOutputSchema = z.object({
  status: z.literal(AWAITING_USER_INPUT_STATUS),
  kind: z.enum(['confirm', 'choice', 'text']),
  prompt: z.string().trim().min(1),
  options: z.array(z.string()).optional(),
});

type AskInput = z.infer<typeof AskInputSchema>;

/** Register harness tools shipped with THEORUM. */
function registerHarnessTools(): void {
  registerTool({
    type: 'function',
    name: 'ask_user',
    description: 'Ask the user a question (completes with awaiting_user_input)', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    category: 'conversation',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: AskInputSchema,
    output: AskOutputSchema,
    handler: (input: AskInput) => {
      const out: z.infer<typeof AskOutputSchema> = {
        status: AWAITING_USER_INPUT_STATUS,
        kind: input.kind,
        prompt: input.prompt,
      };
      if (input.kind === 'choice' && input.options?.length) {
        out.options = input.options;
      }
      return out;
    },
  });
}

export { registerHarnessTools };
