import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { asRecord, nonEmptyString } from '../../kernel/engine/record.ts';
import type { JsonObject } from '../../kernel/json.ts';
import {
  defineProtocol,
  type Protocol,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../kernel/protocols/mod.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type { ImageResponseFormat, ModelRequest } from '../../kernel/types.ts';
import { imagesFromChatMessage, imagesFromImagesBody, OPENROUTER_IMAGE_TOOL } from './image.ts';
import { buildChatMessages } from './openai/compat.ts';
import {
  buildImagesPayload,
  extractPromptText,
  imageToolParameters,
} from './openai/image-payload.ts';
import { openAiUsageTokens } from './openai/usage.ts';

function json(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function tokens(row: JsonObject): ProtocolEvent[] {
  const counted = openAiUsageTokens(row.usage);
  return counted ? [{ type: 'tokens', tokens: counted }] : [];
}

function noImage(): TheoremError {
  return new TheoremError('bad_response', 'no image returned from image generation');
}

/** `/images`: the picture alone, answered whole. */
async function* images(context: ProtocolContext, request: ProtocolRequest) {
  const body = json(buildImagesPayload({ ...request, apiId: context.apiId } as ModelRequest));
  for await (const row of context.send(body, { stream: false })) {
    const media = imagesFromImagesBody(row);
    if (!media.length) throw noImage();
    for (const item of media) yield { type: 'media', media: item } as ProtocolEvent;
    yield* tokens(row);
    // why: the endpoint answers whole or not at all: a body with images completed.
    yield { type: 'done', stop: { kind: 'completed' } } as ProtocolEvent;
  }
}

/** Text with the picture: Chat Completions with OpenRouter's image tool, on the chat path. */
async function* withText(
  context: ProtocolContext,
  request: ProtocolRequest,
  image: ImageResponseFormat,
) {
  const body = json({
    model: context.apiId,
    stream: false,
    provider: { require_parameters: true },
    messages: buildChatMessages(request),
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    ...(request.thinking ? { reasoning: { effort: request.thinking } } : {}),
    tools: [{ type: OPENROUTER_IMAGE_TOOL, parameters: imageToolParameters(image) }],
  });
  for await (const row of context.send(body, { stream: false, path: '/chat/completions' })) {
    const choice = asRecord(Array.isArray(row.choices) ? row.choices[0] : undefined);
    const message = asRecord(choice?.message);
    const text = nonEmptyString(message?.content);
    if (text) yield { type: 'text', text } as ProtocolEvent;
    const media = message ? imagesFromChatMessage(message) : [];
    if (!media.length) throw noImage();
    for (const item of media) yield { type: 'media', media: item } as ProtocolEvent;
    yield* tokens(row);
    const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
    const native =
      typeof choice?.native_finish_reason === 'string' ? choice.native_finish_reason : undefined;
    yield { type: 'done', stop: turnStopFromOpenAiFinishReason(finish, native) } as ProtocolEvent;
  }
}

/** OpenRouter's image generation: `/images`, or the chat path with its image tool when text is wanted too. */
export const openRouterImages: Protocol<Record<string, never>> = defineProtocol({
  id: 'openRouterImages',
  name: 'OpenRouter Images',
  description: "OpenRouter's image generation, with or without text beside the picture.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { image: '/images' },
  operationNames: { image: 'generate_content' },
  options: z.strictObject({}),
  create(context) {
    return {
      complete(request) {
        const image = request.image;
        if (!image) throw new TheoremError('request', 'missing image response format');
        if (!extractPromptText(request.input))
          throw new TheoremError('request', 'empty text for image generation');
        return image.includeText ? withText(context, request, image) : images(context, request);
      },
    };
  },
});
