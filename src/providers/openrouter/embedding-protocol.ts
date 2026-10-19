import { z } from 'zod';
import type { JsonObject } from '../../kernel/json.ts';
import {
  defineProtocol,
  type EmbeddingCall,
  type EmbeddingModelLimits,
  type Protocol,
} from '../../kernel/protocols/mod.ts';
import type { EmbeddingInput, EmbeddingResult } from '../../kernel/types.ts';
import { base64ToBytes } from '../../kernel/util/base64.ts';

/** What an `openRouterEmbedding` binding sets in `options`. */
export interface OpenRouterEmbeddingOptions {
  encodingFormat?: 'float' | 'base64';
}

const options: z.ZodType<OpenRouterEmbeddingOptions> = z.strictObject({
  encodingFormat: z
    .enum(['float', 'base64'])
    .optional()
    .describe(
      'How OpenRouter sends each vector back: as a list of numbers (`float`) or packed into a base64 string (`base64`, smaller on the wire). Theorem decodes both to the same numbers. Absent: `float`.',
    ),
});

// why: OpenRouter's embeddings reference takes images only and caps neither inputs nor images per input; a text-only model refuses an image itself.
const LIMITS: EmbeddingModelLimits = { media: [{ accept: ['image/*'] }] };

/** A string stays a string; a multimodal input is one `{ content }` item, as OpenRouter documents. */
function inputValue(input: EmbeddingInput): string | JsonObject {
  if (typeof input === 'string') return input;
  return {
    content: input.parts.map((part): JsonObject => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      const url = part.type === 'media' ? `data:${part.mimeType};base64,${part.data}` : part.uri;
      return { type: 'image_url', image_url: { url } };
    }),
  };
}

function embeddingValues(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      throw new Error('OpenRouter returned an embedding with a non-finite value');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error('OpenRouter returned an embedding in an unsupported format');
  }
  const bytes = base64ToBytes(value);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('OpenRouter returned an invalid base64 embedding length');
  }
  return Array.from(
    new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
    ),
  );
}

export const openRouterEmbedding: Protocol<OpenRouterEmbeddingOptions> = defineProtocol({
  id: 'openRouterEmbedding',
  name: 'OpenRouter Embeddings',
  description: 'OpenRouter embedding models, including supported multimodal models.',
  endpoints: { embedding: '/embeddings' },
  options,
  embeddingLimits: () => LIMITS,
  create(context) {
    return {
      async embed(request: EmbeddingCall): Promise<EmbeddingResult> {
        const parsed = options.parse(request.options ?? {});
        const inputs = Array.isArray(request.input) ? request.input : [request.input];
        const body: JsonObject = {
          model: context.apiId,
          input:
            inputs.length === 1 && typeof inputs[0] === 'string'
              ? inputs[0]
              : inputs.map(inputValue),
        };
        if (parsed.encodingFormat) body.encoding_format = parsed.encodingFormat;
        let row: Record<string, unknown> | undefined;
        for await (const current of context.send(body, { stream: false })) row = current;
        const data = Array.isArray(row?.data) ? row.data : [];
        const usage =
          row?.usage && typeof row.usage === 'object'
            ? (row.usage as Record<string, unknown>)
            : undefined;
        return {
          model: typeof row?.model === 'string' ? row.model : context.apiId,
          embeddings: data.map((item, position) => {
            const record =
              item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
            const values = embeddingValues(record.embedding);
            return {
              index: typeof record.index === 'number' ? record.index : position,
              values,
              dimensions: values.length,
            };
          }),
          ...(typeof usage?.prompt_tokens === 'number'
            ? { usage: { inputTokens: usage.prompt_tokens } }
            : {}),
        };
      },
    };
  },
});
