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

import { toErrorEvent } from '../../guardrails/error.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../kernel/types.ts';
import { bytesToBase64 } from '../shared/pcm.ts';
import type { OpenAiGatewayConfig } from '../types.ts';
import { buildChatMessages, openAiGatewayHeaders } from './openai/compat.ts';
import {
  buildImagesPayload,
  extractPromptText,
  imageToolParameters,
} from './openai/image-payload.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';

const HTTP_OK = 200;
/** OpenRouter chat server tool for inline image generation. */
export const OPENROUTER_IMAGE_TOOL = 'openrouter:image_generation';

export type ImageProviderConfig = OpenAiGatewayConfig;

interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

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

function usageFromRecord(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const usage = raw as Record<string, unknown>;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output;
  if (input + output + total === 0) {
    return null;
  }
  return { input, output, total };
}

function* yieldUsage(usage: TokenUsage | null): Generator<TurnEvent> {
  if (!usage) {
    return;
  }
  yield { type: 'tokens', tokens: usage };
}

export function mediaFromImagesResponse(
  body: Record<string, unknown>,
  fallbackMime?: string,
): { mimeType: string; data: string } | null {
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const first = data[0];
  if (!first || typeof first !== 'object') {
    return null;
  }
  const entry = first as Record<string, unknown>;
  const b64 = typeof entry.b64_json === 'string' ? entry.b64_json : '';
  if (!b64) {
    return null;
  }
  const mimeType =
    typeof entry.media_type === 'string' && entry.media_type.length > 0
      ? entry.media_type
      : fallbackMime;
  if (!mimeType) {
    return null;
  }
  return { mimeType, data: b64 };
}

export async function fetchImageAsBase64(
  url: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<{ mimeType: string; data: string } | null> {
  const res = await fetchFn(url, { signal });
  if (res.status !== HTTP_OK) {
    return null;
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) {
    return null;
  }
  return { mimeType, data: bytesToBase64(bytes) };
}

export function markdownImageUrls(content: string): string[] {
  const urls: string[] = [];
  const pattern = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of content.matchAll(pattern)) {
    const url = match[1];
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

export function plainTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.replace(/!\[[^\]]*]\([^)]+\)/g, '').trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      const entry = part as Record<string, unknown>;
      if (entry.type === 'text' && typeof entry.text === 'string') {
        return entry.text;
      }
      return '';
    })
    .join('\n')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .trim();
}

function httpImageUrlFromPart(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'image_url') {
    return undefined;
  }
  const imageUrl = entry.image_url;
  if (!imageUrl || typeof imageUrl !== 'object') {
    return undefined;
  }
  const url = (imageUrl as Record<string, unknown>).url;
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    return url;
  }
  return undefined;
}

function inlineImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const url = httpImageUrlFromPart(part as Record<string, unknown>);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

async function postJson(
  config: ImageProviderConfig,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  return await fetchFn(`${baseUrl(config)}${path}`, {
    method: 'POST',
    headers: buildImageHeaders(apiKey, config),
    body: JSON.stringify(body),
    signal,
  });
}

function imageHttpError(res: Response, label: string): TurnEvent | undefined {
  if (res.status !== HTTP_OK) {
    return toErrorEvent(`${label} HTTP ${String(res.status)}`);
  }
  return undefined;
}

async function requestImages(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): Promise<Response> {
  return await postJson(config, apiKey, '/images', buildImagesPayload(req), req.signal);
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
    reasoning: { effort: req.thinking },
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
  return await postJson(
    config,
    apiKey,
    '/chat/completions',
    buildInterleavedChatPayload(req),
    req.signal,
  );
}

export async function* yieldInterleavedChat(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): AsyncGenerator<TurnEvent> {
  const res = await requestInterleavedChat(req, config, apiKey);
  const httpErr = imageHttpError(res, 'Image chat');
  if (httpErr) {
    yield httpErr;
    return;
  }

  const body = (await res.json()) as Record<string, unknown>;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    yield toErrorEvent('no chat choices returned for image generation');
    return;
  }

  const first = choices[0];
  if (!first || typeof first !== 'object') {
    yield toErrorEvent('invalid chat choice for image generation');
    return;
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') {
    yield toErrorEvent('no assistant message returned for image generation');
    return;
  }
  const content = (message as Record<string, unknown>).content;
  const text = plainTextFromContent(content);
  if (text) {
    yield { type: 'text', text };
  }

  const fetchFn = config.fetch ?? fetch;
  const urls = [
    ...inlineImageUrls(content),
    ...(typeof content === 'string' ? markdownImageUrls(content) : []),
  ];
  let emittedMedia = false;
  for (const url of urls) {
    const media = await fetchImageAsBase64(url, fetchFn, req.signal);
    if (!media) {
      continue;
    }
    emittedMedia = true;
    yield { type: 'media', media };
  }
  if (!emittedMedia) {
    yield toErrorEvent('no image returned from chat image generation');
    return;
  }

  yield* yieldUsage(usageFromRecord(body.usage));
  yield { type: 'done' };
}

export async function* yieldImagesEndpoint(
  req: ProviderCompleteRequest,
  config: ImageProviderConfig,
  apiKey: string,
): AsyncGenerator<TurnEvent> {
  const res = await requestImages(req, config, apiKey);
  const httpErr = imageHttpError(res, 'Image');
  if (httpErr) {
    yield httpErr;
    return;
  }

  const body = (await res.json()) as Record<string, unknown>;
  const media = mediaFromImagesResponse(body, req.image?.mimeType);
  if (!media) {
    yield toErrorEvent('no image returned from image generation');
    return;
  }

  yield { type: 'media', media };
  yield* yieldUsage(usageFromRecord(body.usage));
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
    yield toErrorEvent('missing image response format');
    return;
  }

  const prompt = extractPromptText(req.input);
  if (!prompt) {
    yield toErrorEvent('empty text for image generation');
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
