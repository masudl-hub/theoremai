import { TheoremError, toErrorEvent } from '../../guardrails/error.ts';
import { asRecord, nonEmptyString } from '../../kernel/engine/record.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type { ModelProvider, ProviderCompleteRequest, ProviderEvent } from '../../kernel/types.ts';
import { networkFetch } from '../shared/upstream-tap.ts';
import { bearerFetch } from '../shared/vault.ts';
import type { OpenAiGatewayTransport } from '../types.ts';
import { buildChatMessages, httpErrorEvent, openAiGatewayHeaders } from './openai/compat.ts';
import {
  buildImagesPayload,
  extractPromptText,
  imageToolParameters,
} from './openai/image-payload.ts';
import { openAiUsageTokens } from './openai/usage.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';

const HTTP_OK = 200;
export const OPENROUTER_IMAGE_TOOL = 'openrouter:image_generation';

export type ImageProviderConfig = OpenAiGatewayTransport;

export function buildImageHeaders(
  apiKey: string,
  config: ImageProviderConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const gateway = openAiGatewayHeaders(config);
  if (gateway) {
    Object.assign(headers, gateway);
  }
  return headers;
}

function baseUrl(config: ImageProviderConfig): string {
  return config.baseUrl?.replace(/\/+$/, '') ?? 'https://openrouter.ai/api/v1';
}

function* yieldUsage(raw: unknown): Generator<ProviderEvent> {
  const tokens = openAiUsageTokens(raw);
  if (!tokens) {
    return;
  }
  yield { type: 'tokens', tokens };
}

/** `/images` answers `data[]` of `b64_json` + `media_type` (probe 23/09/2026, bytedance-seed/seedream-4.5). */
export function imagesFromImagesBody(
  body: Record<string, unknown>,
): { mimeType: string; data: string }[] {
  const entries = Array.isArray(body.data) ? body.data : [];
  return entries.flatMap((value) => {
    const entry = asRecord(value);
    const data = nonEmptyString(entry?.b64_json);
    const mimeType = nonEmptyString(entry?.media_type);
    return data && mimeType ? [{ mimeType, data }] : [];
  });
}

function mediaFromDataUrl(url: unknown): { mimeType: string; data: string } | undefined {
  if (typeof url !== 'string') {
    return undefined;
  }
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { mimeType: match[1], data: match[2] };
}

/**
 * OpenRouter returns chat images on `message.images[]` as `{ type: 'image_url', image_url: { url } }`
 * with a base64 data url; `message.content` holds only the text (probe 23/09/2026,
 * gemini-3.1-flash-lite with the image generation tool).
 */
export function imagesFromChatMessage(
  message: Record<string, unknown>,
): { mimeType: string; data: string }[] {
  const images = Array.isArray(message.images) ? message.images : [];
  return images.flatMap((entry) => {
    const media = mediaFromDataUrl(asRecord(asRecord(entry)?.image_url)?.url);
    return media ? [media] : [];
  });
}

async function postJson(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const fetchFn = bearerFetch(req, networkFetch(config.fetch ?? fetch), config.vault, apiKey);
  return await fetchFn(`${baseUrl(config)}${path}`, {
    method: 'POST',
    headers: buildImageHeaders(apiKey, config),
    body: JSON.stringify(body),
    signal: req.signal,
  });
}

async function readTapedJson(
  req: ProviderCompleteRequest,
  res: Response,
): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  req.tapUpstream?.(body);
  return body;
}

async function requestImages(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): Promise<Response> {
  return await postJson(req, config, apiKey, '/images', buildImagesPayload(req));
}

export function buildInterleavedChatPayload(req: ProviderCompleteRequest): Record<string, unknown> {
  if (!req.image) {
    throw new Error('buildInterleavedChatPayload requires req.image');
  }
  return {
    model: req.apiId,
    stream: false,
    messages: buildChatMessages(req),
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
    ...(req.thinking ? { reasoning: { effort: req.thinking } } : {}),
    tools: [
      {
        type: OPENROUTER_IMAGE_TOOL,
        parameters: imageToolParameters(req.image),
      },
    ],
  };
}

async function requestInterleavedChat(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): Promise<Response> {
  return await postJson(req, config, apiKey, '/chat/completions', buildInterleavedChatPayload(req));
}

export async function* yieldInterleavedChat(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): AsyncGenerator<ProviderEvent> {
  const res = await requestInterleavedChat(req, config, apiKey);
  if (res.status !== HTTP_OK) {
    yield await httpErrorEvent(res, 'Image chat');
    return;
  }

  const body = await readTapedJson(req, res);
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    yield toErrorEvent(
      new TheoremError('bad_response', 'no chat choices returned for image generation'),
    );
    return;
  }
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  if (!message) {
    yield toErrorEvent(
      new TheoremError('bad_response', 'no assistant message returned for image generation'),
    );
    return;
  }
  const text = nonEmptyString(message.content);
  if (text) {
    yield { type: 'text', text };
  }
  const images = imagesFromChatMessage(message);
  if (images.length === 0) {
    yield toErrorEvent(
      new TheoremError('bad_response', 'no image returned from chat image generation'),
    );
    return;
  }
  for (const media of images) {
    yield { type: 'media', media };
  }

  yield* yieldUsage(body.usage);
  yield {
    type: 'done',
    stop: turnStopFromOpenAiFinishReason(
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
      typeof choice?.native_finish_reason === 'string' ? choice.native_finish_reason : undefined,
    ),
  };
}

export async function* yieldImagesEndpoint(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): AsyncGenerator<ProviderEvent> {
  const res = await requestImages(req, config, apiKey);
  if (res.status !== HTTP_OK) {
    yield await httpErrorEvent(res, 'Image');
    return;
  }

  const body = await readTapedJson(req, res);
  const images = imagesFromImagesBody(body);
  if (images.length === 0) {
    yield toErrorEvent(new TheoremError('bad_response', 'no image returned from image generation'));
    return;
  }
  for (const media of images) {
    yield { type: 'media', media };
  }
  yield* yieldUsage(body.usage);
  // The endpoint answers whole or not at all: a body with images completed.
  yield { type: 'done', stop: { kind: 'completed' } };
}

export async function* streamImage(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig = {},
): AsyncGenerator<ProviderEvent> {
  let apiKey: string;
  try {
    apiKey = resolveOpenAiGatewayApiKey(config, req.keySlot);
  } catch (err) {
    yield toErrorEvent(err);
    return;
  }

  if (!req.image) {
    yield toErrorEvent(new TheoremError('request', 'missing image response format'));
    return;
  }

  const prompt = extractPromptText(req.input);
  if (!prompt) {
    yield toErrorEvent(new TheoremError('request', 'empty text for image generation'));
    return;
  }

  if (req.image.includeText) {
    yield* yieldInterleavedChat(req, config, apiKey);
    return;
  }

  yield* yieldImagesEndpoint(req, config, apiKey);
}

export function createImageProvider(config: ImageProviderConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamImage(req, config),
  };
}
