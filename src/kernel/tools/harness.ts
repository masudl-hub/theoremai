/**
 * Harness tools shipped with THEOREM.
 *
 * @module
 */

import { z } from 'zod';
import { registerTool } from '../default-scope.ts';
import { AWAITING_USER_INPUT_STATUS } from '../schema.ts';
import type { ToolDefinitionInput } from './types.ts';

type AskKind = 'confirm' | 'choice' | 'text';

type AskInput = { kind: AskKind; prompt: string; options?: string[] };

type AskOutput = AskInput & { status: typeof AWAITING_USER_INPUT_STATUS };

const AskInputSchema: z.ZodType<AskInput> = z.object({
  kind: z.enum(['confirm', 'choice', 'text']),
  prompt: z.string().trim().min(1),
  options: z.array(z.string()).optional(),
});

const AskOutputSchema: z.ZodType<AskOutput> = z.object({
  status: z.literal(AWAITING_USER_INPUT_STATUS),
  kind: z.enum(['confirm', 'choice', 'text']),
  prompt: z.string().trim().min(1),
  options: z.array(z.string()).optional(),
});

/** `ask_user`: completes with `awaiting_user_input`. A scope of its own registers it with `tools.register`. */
const askUserTool: ToolDefinitionInput<AskInput, AskOutput> = {
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
    const out: AskOutput = {
      status: AWAITING_USER_INPUT_STATUS,
      kind: input.kind,
      prompt: input.prompt,
    };
    if (input.kind === 'choice' && input.options?.length) {
      out.options = input.options;
    }
    return out;
  },
};

/** Register the harness tools in the default scope. */
function registerHarnessTools(): void {
  registerTool(askUserTool);
}

export type { AskInput, AskKind, AskOutput };
export { askUserTool, registerHarnessTools };
