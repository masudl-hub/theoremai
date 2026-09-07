/**
 * OpenAI-compatible `/audio/speech` transport (internal).
 *
 * Hosts use `createProvider(profile, { openAiGateway })` — this module is selected
 * when the profile is an openAi speech role. Not a separate public door.
 *
 * @module
 */

import { toErrorEvent } from '../../guardrails/error.ts';
import type {
  InteractionPart,
  ModelProvider,
  ProfileSpeechSpec,
  ProviderCompleteRequest,
  SpeechAudioFormat,
  TurnEvent,
} from '../../kernel/types.ts';
import { bytesToBase64, wrapPcmAsWav } from '../shared/pcm.ts';
import type { OpenAiGatewayConfig } from '../types.ts';
import { openAiGatewayHeaders } from './openai/compat.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';

const HTTP_OK = 200;

/** Credentials for the openAi speech path — gateway config + optional voice. */
export type SpeechProviderConfig = OpenAiGatewayConfig & {
  /** Fallback TTS voice when the profile does not pin `speech.voice`. */
  voice?: string;
};

export function extractInputText(input: InteractionPart[]): string {
  return input
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join(' ')
    .trim();
}

export function buildSpeechHeaders(
  apiKey: string,
  config: SpeechProviderConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const gateway = openAiGatewayHeaders(config);
  if (gateway) Object.assign(headers, gateway);
  return headers;
}

export function buildPayload(
  req: ProviderCompleteRequest,
  text: string,
  speech: ProfileSpeechSpec | undefined,
  configVoice?: string,
): Record<string, unknown> {
  const voice = speech?.voice ?? configVoice;
  const payload: Record<string, unknown> = {
    model: req.apiId,
    input: text,
  };
  if (speech?.format) {
    payload.response_format = speech.format;
  }
  if (voice) {
    payload.voice = voice;
  }
  return payload;
}

export async function requestSpeech(
  apiKey: string,
  text: string,
  req: ProviderCompleteRequest,
  config: SpeechProviderConfig,
): Promise<Response> {
  const fetchFn = config.fetch ?? fetch;
  const baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://openrouter.ai/api/v1';
  const url = `${baseUrl}/audio/speech`;
  return await fetchFn(url, {
    method: 'POST',
    headers: buildSpeechHeaders(apiKey, config),
    body: JSON.stringify(buildPayload(req, text, req.speech, config.voice)),
    signal: req.signal,
  });
}

export function* yieldSpeechSuccess(
  rawBytes: Uint8Array,
  text: string,
  format?: SpeechAudioFormat,
  contentType?: string | null,
): Generator<TurnEvent> {
  let mediaMime = contentType?.split(';')[0]?.trim() || 'application/octet-stream';
  let mediaBytes = rawBytes;

  if (format === 'pcm') {
    mediaMime = 'audio/wav';
    mediaBytes = wrapPcmAsWav(rawBytes);
  } else if (format === 'mp3') {
    mediaMime = 'audio/mpeg';
  }

  yield {
    type: 'media',
    media: { mimeType: mediaMime, data: bytesToBase64(mediaBytes) },
  };

  const inputTokens = Math.max(1, Math.round(text.length / 4));
  const outputTokens = Math.max(1, Math.round(rawBytes.length / 100));
  yield {
    type: 'tokens',
    tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
  };

  yield { type: 'done' };
}

export async function* streamSpeech(
  req: ProviderCompleteRequest,
  config: SpeechProviderConfig = {},
): AsyncGenerator<TurnEvent> {
  let apiKey: string;
  try {
    apiKey = resolveOpenAiGatewayApiKey(config, req.keySlot);
  } catch (err) {
    yield toErrorEvent(err);
    return;
  }

  const text = extractInputText(req.input);
  if (!text) {
    yield toErrorEvent('empty text for speech');
    return;
  }

  const res = await requestSpeech(apiKey, text, req, config);
  if (res.status !== HTTP_OK) {
    yield toErrorEvent(`Speech HTTP ${String(res.status)}`);
    return;
  }

  const arrayBuffer = await res.arrayBuffer();
  const rawBytes = new Uint8Array(arrayBuffer);
  if (rawBytes.length === 0) {
    yield toErrorEvent('no audio returned from speech');
    return;
  }

  const format = req.speech?.format;
  for (const ev of yieldSpeechSuccess(rawBytes, text, format, res.headers.get('content-type'))) {
    yield ev;
  }
}

/** Internal ModelProvider for openAi speech roles. */
export function createSpeechProvider(config: SpeechProviderConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamSpeech(req, config),
  };
}
