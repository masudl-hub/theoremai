/**
 * OpenAI-compatible image generation transport (internal).
 *
 * Hosts use `createProvider(profile, { openAiGateway })` — this module is selected
 * when the profile is an openAi image role on OpenRouter.
 *
 * Image-only turns POST `/images`. When `image.includeText` is set, chat
 * completions carry an OpenRouter image-generation server tool so the model may
 * return interleaved assistant text and images.
 *
 * @module
 */

import { TheoremError, toErrorEvent } from '../../guardrails/error.ts';
import { asRecord, nonEmptyString } from '../../kernel/engine/record.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../kernel/types.ts';
import { networkFetch, tapFetch } from '../shared/upstream-tap.ts';
import type { OpenAiGatewayConfig } from '../types.ts';
import { buildChatMessages, httpErrorEvent, openAiGatewayHeaders } from './openai/compat.ts';
import {
  buildImagesPayload,
  extractPromptText,
  imageToolParameters,
} from './openai/image-payload.ts';
import { openAiUsageTokens } from './openai/usage.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';

const HTTP_OK = 200;
/** OpenRouter chat server tool for inline image generation. */
export const OPENROUTER_IMAGE_TOOL = 'openrouter:image_generation';

export type ImageProviderConfig = OpenAiGatewayConfig;

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

function* yieldUsage(raw: unknown): Generator<TurnEvent> {
  const tokens = openAiUsageTokens(raw);
  if (!tokens) {
    return;
  }
  yield { type: 'tokens', tokens };
}

/**
 * Images on a `/images` response: `data[]` entries of `b64_json` +
 * `media_type` (probe 23/09/2026, bytedance-seed/seedream-4.5).
 */
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

/** A `data:<mime>;base64,<bytes>` url as media; any other url carries no inline bytes. */
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
 * Images on a chat completion message. OpenRouter returns them on
 * `message.images[]` as `{ type: 'image_url', image_url: { url } }` with a
 * base64 data url (probe 23/09/2026, gemini-3.1-flash-lite with the image
 * generation tool); `message.content` holds only the text.
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
  const fetchFn = tapFetch(req.tapUpstream, networkFetch(config.fetch ?? fetch), req.keySlot);
  return await fetchFn(`${baseUrl(config)}${path}`, {
    method: 'POST',
    headers: buildImageHeaders(apiKey, config),
    body: JSON.stringify(body),
    signal: req.signal,
  });
}

/** The JSON body of a successful response, taped as received. */
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
    ...(req.thinking && req.thinking !== 'none' ? { reasoning: { effort: req.thinking } } : {}),
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
): AsyncGenerator<TurnEvent> {
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
  const message = asRecord(asRecord(choices[0])?.message);
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
  yield { type: 'done' };
}

export async function* yieldImagesEndpoint(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): AsyncGenerator<TurnEvent> {
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
  yield { type: 'done' };
}

export async function* streamImage(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig = {},
): AsyncGenerator<TurnEvent> {
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

/** Internal ModelProvider for openAi image roles on OpenRouter. */
export function createImageProvider(config: ImageProviderConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamImage(req, config),
  };
}
