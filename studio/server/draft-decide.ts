/**
 * `POST <base>/decide`: one decision on lent keys. The browser authors the profile and its
 * questions, so the server takes only the fields a studio decision compiles to, within the keys'
 * decision limits, and checks the model, the state, and each question against the keys before it
 * spends anything.
 *
 * @module
 */
import { TheoremError, validateDecisionRequest, z } from '@theoremjs/agents';
import type { DecisionProfileDefinition } from '@theoremjs/agents/kernel';
import { KEY_SLOT_NAME } from '@theoremjs/agents/schema';
import { readBody } from '@theoremjs/web/server';
import type { LentDecisionLimits } from '../lent-keys.ts';
import { runStudioDecision } from '../runtime.ts';
import { defineDraft } from '../runtime-scope.ts';
import type { LentRuntime } from './draft-handler.ts';
import { errorJson, noStoreJson } from './draft-replies.ts';
import { lentRoute, lentVault } from './lent-draft.ts';

/** The decision request lent keys answer: only the fields a studio decision compiles to, within `limits`. A setting left out stays out. */
export function decisionRequestSchema(limits: LentDecisionLimits) {
  const name = z.string().trim().min(1).max(limits.nameChars);
  const id = z.string().trim().min(1).max(limits.idChars);
  const entry = z.string().trim().min(1).max(limits.criterionChars);
  const slot = z.string().regex(KEY_SLOT_NAME);
  const labelled = z
    .record(name, entry)
    .refine(
      (record) => Object.keys(record).length > 0 && Object.keys(record).length <= limits.criteria,
    );
  const instructions = z.string().trim().min(1).max(limits.instructionsChars);
  const question = z.discriminatedUnion('type', [
    z.object({ type: z.literal('choice'), instructions, criteria: labelled }),
    z.object({
      type: z.literal('score'),
      instructions,
      criteria: z.array(entry).min(2).max(limits.criteria),
    }),
    z.object({ type: z.literal('noul'), instructions, criteria: labelled.optional() }),
    z.object({
      type: z.literal('box'),
      instructions,
      image: z.string().trim().min(1).max(limits.instructionsChars).optional(),
    }),
  ]);
  // why: Base64 is four characters for every three bytes, so the byte limit bounds the text before it is decoded.
  const image = z.object({
    mimeType: z.enum(['image/png', 'image/jpeg']),
    data: z.string().max(Math.ceil(limits.imageBytes / 3) * 4),
  });
  return z.object({
    profile: z.object({
      type: z.literal('decision'),
      id,
      identity: z.object({ handle: name }),
      models: z
        .record(
          name,
          z.object({
            protocol: name,
            provider: name,
            apiId: id,
            keySlot: slot.optional(),
            fallbackKeySlot: slot.optional(),
            options: z.record(z.string(), z.json()).optional(),
            timeoutMs: z.number().int().min(1).max(limits.timeoutMs).optional(),
          }),
        )
        .refine((models) => Object.keys(models).length === 1),
      inputs: z.object({
        state: z.literal('json'),
        maxStateBytes: z.number().int().min(1).max(limits.stateBytes).optional(),
      }),
      decision: z.object({ contract: id }),
      observability: z.record(z.string(), z.unknown()).optional(),
      labels: z.record(z.string(), z.unknown()).optional(),
    }),
    questions: z
      .record(name, question)
      .refine(
        (record) =>
          Object.keys(record).length > 0 && Object.keys(record).length <= limits.questions,
      ),
    state: z.unknown(),
    assets: z
      .record(name, image)
      .refine((record) => Object.keys(record).length <= limits.images)
      .optional(),
  });
}

/** What a decision on lent keys runs with. */
export type DraftDecideOptions = {
  runtime: LentRuntime;
  /** Spends the decision once the request is one the keys would answer; throws to refuse it. */
  spend: (request: Request) => Promise<void>;
};

/** Answers one decision on the lent keys, with the records it wrote; a failed one is traced too. */
export async function draftDecide(
  request: Request,
  options: DraftDecideOptions,
): Promise<Response> {
  let labels: DecisionProfileDefinition['labels'];
  try {
    const body = await readBody(request, decisionRequestSchema(options.runtime.keys.decision));
    const profile = defineDraft(body.profile as DecisionProfileDefinition);
    labels = profile.labels;
    const selected = lentRoute('decision', profile);
    const { keys } = options.runtime;
    const refused =
      keys.violation(selected)?.message ??
      keys.stateViolation(selected, body.state) ??
      Object.values(body.questions)
        .map((question) => keys.questionViolation(selected, question))
        .find(Boolean);
    if (refused) throw new TheoremError('request', `studio decide: ${refused}`);
    validateDecisionRequest(
      {
        profile: profile.id,
        state: body.state,
        questions: body.questions,
        assets: body.assets,
        signal: request.signal,
      },
      profile,
    );
    const vault = lentVault(options.runtime, profile, 'decide');
    await options.spend(request);
    const { result, traces } = await runStudioDecision(
      { agentId: profile.id, profile: body.profile, customTools: [], questions: body.questions },
      body.state as Parameters<typeof runStudioDecision>[1],
      { vault },
      request.signal,
      body.assets,
    );
    return noStoreJson({ result, traces });
  } catch (err) {
    // A failed decision is traced too; the page shows what it left.
    return errorJson(err, labels);
  }
}
