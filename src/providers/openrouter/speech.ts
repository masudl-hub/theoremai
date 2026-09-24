/**
 * OpenAI-compatible `/audio/speech` transport (internal).
 *
 * Hosts use `createProvider(profile, { openAiGateway })` — this module is selected
 * when the profile is an openAi speech role. Not a separate public door.
 *
 * @module
 */

import { TheoremError, toErrorEvent } from '../../guardrails/error.ts';
import type {
  InteractionPart,
  ModelProvider,
  ProfileSpeechSpec,
  ProviderCompleteRequest,
  TurnEvent,
} from '../../kernel/types.ts';
import { bytesToBase64 } from '../../kernel/util/base64.ts';
import { mimeEssence } from '../../kernel/util/mime.ts';
import { pcmFormatFromMime, wrapPcmAsWav } from '../shared/pcm.ts';
import { networkFetch, tapFetch } from '../shared/upstream-tap.ts';
import type { OpenAiGatewayConfig } from '../types.ts';
import { httpErrorEvent, openAiGatewayHeaders } from './openai/compat.ts';
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
  const fetchFn = tapFetch(req.tapUpstream, networkFetch(config.fetch ?? fetch), req.keySlot);
  const baseUrl = config.baseUrl?.replace(/\/+$/, '') ?? 'https://openrouter.ai/api/v1';
  const url = `${baseUrl}/audio/speech`;
  return await fetchFn(url, {
    method: 'POST',
    headers: buildSpeechHeaders(apiKey, config),
    body: JSON.stringify(buildPayload(req, text, req.speech, config.voice)),
    signal: req.signal,
  });
}

/**
 * The response's `content-type` states the audio (probe 23/09/2026:
 * `audio/pcm;rate=24000;channels=1` for `pcm`). Raw PCM with a stated rate is
 * wrapped as WAV; anything else keeps its reported type.
 */
export function* yieldSpeechSuccess(
  rawBytes: Uint8Array,
  contentType: string | null,
): Generator<TurnEvent> {
  const format = pcmFormatFromMime(contentType ?? '');
  const media = format
    ? { mimeType: 'audio/wav', data: bytesToBase64(wrapPcmAsWav(rawBytes, format)) }
    : {
        mimeType: mimeEssence(contentType ?? '') || 'application/octet-stream',
        data: bytesToBase64(rawBytes),
      };

  yield { type: 'media', media };

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
    yield toErrorEvent(new TheoremError('request', 'empty text for speech'));
    return;
  }

  const res = await requestSpeech(apiKey, text, req, config);
  if (res.status !== HTTP_OK) {
    yield await httpErrorEvent(res, 'Speech');
    return;
  }

  const arrayBuffer = await res.arrayBuffer();
  const rawBytes = new Uint8Array(arrayBuffer);
  const contentType = res.headers.get('content-type');
  // The audio body as a tape row; the tape keeps its hash, not its bytes.
  req.tapUpstream?.({
    eventType: 'http_body',
    mime_type: contentType ?? '',
    data: bytesToBase64(rawBytes),
  });
  if (rawBytes.length === 0) {
    yield toErrorEvent(new TheoremError('bad_response', 'no audio returned from speech'));
    return;
  }

  for (const ev of yieldSpeechSuccess(rawBytes, contentType)) {
    yield ev;
  }
}

/** Internal ModelProvider for openAi speech roles. */
export function createSpeechProvider(config: SpeechProviderConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamSpeech(req, config),
  };
}
