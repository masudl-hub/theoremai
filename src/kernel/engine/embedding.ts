import { TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import type { ProviderHostOptions } from '../protocols/runtime.ts';
import { guardedCall } from '../provider-runtime.ts';
import type { KernelRegistry } from '../registry/kernel-registry.ts';
import type {
  EmbeddingInput,
  EmbeddingProfile,
  EmbeddingRequest,
  EmbeddingResult,
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

function inputsOf(input: EmbeddingRequest['input']): readonly EmbeddingInput[] {
  return Array.isArray(input) ? input : [input as EmbeddingInput];
}

function validateInput(profile: EmbeddingProfile, input: EmbeddingInput): void {
  const parts =
    typeof input === 'string'
      ? [{ type: 'text' as const, text: input }]
      : input && Array.isArray(input.parts)
        ? input.parts
        : [];
  if (parts.length === 0)
    throw new TheoremError('request', `Profile ${profile.id} received an empty embedding input`); // labels-exempt: developer contract error
  for (const part of parts) {
    if (part.type === 'text' && profile.inputs.text === false)
      throw new TheoremError(
        'unsupported',
        `Profile ${profile.id} does not accept text embedding input`, // labels-exempt: developer contract error
      );
    if (part.type !== 'text' && !profile.inputs.attachments)
      throw new TheoremError(
        'unsupported',
        `Profile ${profile.id} does not accept media embedding input`, // labels-exempt: developer contract error
      );
    if (part.type !== 'text' && profile.inputs.attachments) {
      const accepted = profile.inputs.attachments.accept;
      if (
        !accepted.some(
          (pattern) =>
            pattern === part.mimeType ||
            (pattern.endsWith('/*') && part.mimeType.startsWith(pattern.slice(0, -1))),
        )
      )
        throw new TheoremError(
          'unsupported',
          `Profile ${profile.id} does not accept '${part.mimeType}' embedding input`, // labels-exempt: developer contract error
        );
    }
  }
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
  for (const input of inputs) validateInput(profile, input);
  const provider = registry.providers.require(binding.provider, binding.apiId);
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
        ...(binding.options ? { options: binding.options } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return validateResult(result, inputs.length);
    },
  );
}
