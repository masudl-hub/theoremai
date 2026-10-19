import { refuseOverlong } from '../../guardrails/detect-at.ts';
import { TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import { protocolOf } from '../protocols/binding.ts';
import type { EmbeddingModelLimits } from '../protocols/protocol.ts';
import type { ProviderHostOptions } from '../protocols/runtime.ts';
import { guardedCall } from '../provider-runtime.ts';
import { type AttachmentFacts, attachmentsRefused, base64Bytes } from '../registry/attachments.ts';
import { embeddingMediaIssues, embeddingRules } from '../registry/embedding-rules.ts';
import type { KernelRegistry } from '../registry/kernel-registry.ts';
import type {
  EmbeddingInput,
  EmbeddingPart,
  EmbeddingProfile,
  EmbeddingRequest,
  EmbeddingResult,
  EmbeddingTask,
  EmbeddingVector,
  ModelBinding,
} from '../types.ts';
import { tracedCall } from './call-trace.ts';

export interface RunEmbeddingOptions extends ProviderHostOptions {
  sink?: TraceSink;
}

function requireEmbeddingProfile(registry: KernelRegistry, id: string): EmbeddingProfile {
  const profile = registry.profiles.get(id);
  if (profile.type !== 'embedding')
    throw new TheoremError(
      'request',
      `runEmbedding requires profile.type 'embedding' (got '${profile.type}' for ${id})`, // labels-exempt: developer contract error
    );
  return profile;
}

function chooseModel(
  profile: EmbeddingProfile,
  requested: string | undefined,
): [string, ModelBinding] {
  const modelId = requested ?? profile.defaultModel;
  if (requested && !profile.allowModelSelect)
    throw new TheoremError('request', `Profile ${profile.id} does not allow model selection`); // labels-exempt: developer contract error
  const binding = profile.models[modelId];
  if (!binding) throw new TheoremError('request', `Unknown model '${modelId}' for ${profile.id}`); // labels-exempt: developer contract error
  return [modelId, binding];
}

const TASKS: readonly EmbeddingTask[] = ['query', 'document'];

function checkTask(task: unknown): void {
  if (task !== undefined && !TASKS.includes(task as EmbeddingTask))
    throw new TheoremError('request', `Embedding task must be 'query' or 'document'`); // labels-exempt: developer contract error
}

function inputsOf(input: EmbeddingRequest['input']): readonly EmbeddingInput[] {
  return Array.isArray(input) ? input : [input as EmbeddingInput];
}

/** An input's parts; a bare string is one text part. */
function partsOf(input: EmbeddingInput): readonly EmbeddingPart[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return input && Array.isArray(input.parts) ? input.parts : [];
}

/** Text is checked per part; media per input, held to the profile and to what the model takes. */
function validateInputs(
  profile: EmbeddingProfile,
  modelId: string,
  inputs: readonly EmbeddingInput[],
  model: EmbeddingModelLimits | undefined,
): void {
  const rules = embeddingRules(profile.inputs, model);
  if (rules.maxInputs !== undefined && inputs.length > rules.maxInputs)
    throw new TheoremError(
      'request',
      `Model '${modelId}' of ${profile.id} takes at most ${rules.maxInputs} inputs per request`, // labels-exempt: developer contract error
    );
  const media: AttachmentFacts[][] = [];
  for (const input of inputs) {
    const parts = partsOf(input);
    if (parts.length === 0)
      throw new TheoremError('request', `Profile ${profile.id} received an empty embedding input`); // labels-exempt: developer contract error
    const files: AttachmentFacts[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        refuseOverlong(part.text, 'embedding input');
        if (!rules.text)
          throw new TheoremError(
            'unsupported',
            `Profile ${profile.id} does not accept text embedding input`, // labels-exempt: developer contract error
          );
        continue;
      }
      files.push(
        part.type === 'media'
          ? { mimeType: part.mimeType, sizeBytes: base64Bytes(part.data) }
          : { mimeType: part.mimeType },
      );
    }
    media.push(files);
  }
  const issues = embeddingMediaIssues(rules, media);
  if (issues.length > 0) throw attachmentsRefused(issues);
}

function validateResult(result: EmbeddingResult, count: number): EmbeddingResult {
  if (!result.model.trim() || result.embeddings.length !== count)
    throw new TheoremError('bad_response', 'Embedding provider returned an invalid vector count'); // labels-exempt: upstream contract error
  const embeddings: EmbeddingVector[] = result.embeddings.map((vector, index) => {
    if (
      vector.index !== index ||
      vector.dimensions !== vector.values.length ||
      vector.dimensions === 0
    )
      throw new TheoremError('bad_response', 'Embedding provider returned invalid vector metadata'); // labels-exempt: upstream contract error
    if (vector.values.some((value) => !Number.isFinite(value)))
      throw new TheoremError(
        'bad_response',
        'Embedding provider returned a non-finite vector value', // labels-exempt: upstream contract error
      );
    return vector;
  });
  return { ...result, embeddings };
}

export async function runEmbeddingInRegistry(
  registry: KernelRegistry,
  request: EmbeddingRequest,
  options: RunEmbeddingOptions = {},
): Promise<EmbeddingResult> {
  throwIfAborted(request.signal);
  const profile = requireEmbeddingProfile(registry, request.profile);
  const [modelId, binding] = chooseModel(profile, request.model);
  const inputs = inputsOf(request.input);
  checkTask(request.task);
  const provider = registry.providers.require(binding.provider, binding.apiId);
  validateInputs(
    profile,
    modelId,
    inputs,
    protocolOf(provider, binding).embeddingLimits?.(binding.apiId),
  );
  const call = guardedCall(provider, binding, 'embedding', options, {
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return await tracedCall(
    {
      name: `embed ${binding.apiId}`,
      attributes: {
        'gen_ai.operation.name': 'embeddings',
        'gen_ai.provider.name': binding.provider,
        'gen_ai.agent.name': profile.id,
        'gen_ai.request.model': binding.apiId,
        'theorem.model.id': modelId,
        'theorem.embedding.inputs': inputs.length,
        ...(request.task ? { 'theorem.embedding.task': request.task } : {}),
      },
      traceparent: request.traceparent,
      metadata: request.metadata,
      writer: {
        override: options.sink,
        observability: profile.observability,
        guardrails: profile.guardrails,
      },
    },
    async () => {
      const result = await call.embed({
        apiId: binding.apiId,
        input: request.input,
        ...(request.task ? { task: request.task } : {}),
        ...(binding.options ? { options: binding.options } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return validateResult(result, inputs.length);
    },
  );
}
