/**
 * Built-in harness tools registered with THEORUM.
 *
 * @module
 */

import { z } from 'zod';
import { registerTool } from './registry.ts';

const AskInputSchema = z.object({
  kind: z.enum(['confirm', 'choice', 'text']),
  prompt: z.string().trim().min(1),
  options: z.array(z.string()).optional(),
});

const AskOutputSchema = z.object({
  answer: z.unknown(),
});

type AskInput = z.infer<typeof AskInputSchema>;

/** Register harness tools shipped with THEORUM. */
function registerHarnessTools(): void {
  registerTool({
    type: 'function',
    name: 'ask_user',
    description: 'Ask the user a question and wait for a response',
    category: 'conversation',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: AskInputSchema,
    output: AskOutputSchema,
    interactive: {
      render: (input) => {
        const ask = input as AskInput;
        return {
          kind: ask.kind,
          prompt: ask.prompt,
          options: ask.options,
        };
      },
    },
    handler: (_input, ctx) => ({
      answer: ctx.resume?.value ?? ctx.resume?.granted,
    }),
  });
}

export { registerHarnessTools };
