/**
 * `POST <base>/embedding/embed`: one embedding on lent keys, with the records it wrote.
 *
 * @module
 */
import { type ProfileDefinition, TheoremError, z } from '@theoremjs/agents';
import type { EmbeddingProfileDefinition } from '@theoremjs/agents/kernel';
import { embedBodySchema, embedRequest, readBody } from '@theoremjs/react/server';
import { runStudioEmbedding } from '../runtime.ts';
import { defineDraft } from '../runtime-scope.ts';
import type { LentRuntime } from './draft-handler.ts';
import { errorJson, noStoreJson } from './draft-replies.ts';
import { lentRoute, lentVault } from './lent-draft.ts';

const embeddingRequestSchema = embedBodySchema.extend({
  profile: z.record(z.string(), z.unknown()),
});

/** Embeds the input on the lent keys, once the keys allow the profile's model. */
export async function draftEmbedding(request: Request, runtime: LentRuntime): Promise<Response> {
  let labels: EmbeddingProfileDefinition['labels'];
  try {
    const body = await readBody(request, embeddingRequestSchema);
    const profile = defineDraft(body.profile as ProfileDefinition);
    if (profile.type !== 'embedding') {
      throw new TheoremError('request', 'studio embedding requires an embedding profile.');
    }
    labels = profile.labels;
    const violation = runtime.keys.violation(lentRoute('embedding', profile));
    if (violation) throw new TheoremError('request', `studio embedding: ${violation.message}`);
    lentVault(runtime, profile, 'embedding');
    const { result, traces } = await runStudioEmbedding(
      { agentId: profile.id, profile: body.profile as EmbeddingProfileDefinition, customTools: [] },
      embedRequest(body),
      runtime,
    );
    return noStoreJson({ result, traces });
  } catch (err) {
    return errorJson(err, labels);
  }
}
