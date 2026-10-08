import { z } from 'zod';
import { KEY_SLOT_NAME } from '../src/kernel/schema.ts';
import {
  PLAYGROUND_DECISION_MAX_CRITERIA,
  PLAYGROUND_DECISION_MAX_CRITERION_CHARS,
  PLAYGROUND_DECISION_MAX_ID_CHARS,
  PLAYGROUND_DECISION_MAX_INSTRUCTIONS_CHARS,
  PLAYGROUND_DECISION_MAX_NAME_CHARS,
  PLAYGROUND_DECISION_MAX_QUESTIONS,
  PLAYGROUND_DECISION_MAX_STATE_BYTES,
  PLAYGROUND_DECISION_TIMEOUT_MS,
} from './policy.ts';

const name = z.string().trim().min(1).max(PLAYGROUND_DECISION_MAX_NAME_CHARS);
const id = z.string().trim().min(1).max(PLAYGROUND_DECISION_MAX_ID_CHARS);
const entry = z.string().trim().min(1).max(PLAYGROUND_DECISION_MAX_CRITERION_CHARS);
const slot = z.string().regex(KEY_SLOT_NAME);
const labelled = z.record(name, entry)
  .refine((record) =>
    Object.keys(record).length > 0 && Object.keys(record).length <= PLAYGROUND_DECISION_MAX_CRITERIA
  );
const instructions = z.string().trim().min(1).max(PLAYGROUND_DECISION_MAX_INSTRUCTIONS_CHARS);
const question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions, criteria: labelled }),
  z.object({
    type: z.literal('score'),
    instructions,
    criteria: z.array(entry).min(2).max(PLAYGROUND_DECISION_MAX_CRITERIA),
  }),
  z.object({ type: z.literal('noul'), instructions, criteria: labelled.optional() }),
]);

/** The hosted decision request: strips untrusted fields and applies playground limits. */
export const playgroundDecisionRequestSchema = z.object({
  profile: z.object({
    type: z.literal('decision'),
    id,
    identity: z.object({ handle: name }),
    models: z.record(
      name,
      z.object({
        provider: z.enum(['typesafe', 'openrouter']),
        apiId: id,
        keySlot: slot.optional(),
        fallbackKeySlot: slot.optional(),
        providerOptions: z.record(z.string(), z.json()).default({}),
        timeoutMs: z.number().int().min(1).max(PLAYGROUND_DECISION_TIMEOUT_MS).default(
          PLAYGROUND_DECISION_TIMEOUT_MS,
        ),
      }),
    ).refine((models) => Object.keys(models).length === 1),
    inputs: z.object({
      state: z.literal('json'),
      maxStateBytes: z.number().int().min(1).max(PLAYGROUND_DECISION_MAX_STATE_BYTES),
    }),
    decision: z.object({ contract: id }),
    observability: z.record(z.string(), z.unknown()).optional(),
    lexicon: z.record(z.string(), z.unknown()).optional(),
  }),
  questions: z.record(name, question)
    .refine((record) =>
      Object.keys(record).length > 0 &&
      Object.keys(record).length <= PLAYGROUND_DECISION_MAX_QUESTIONS
    ),
  state: z.unknown(),
});
