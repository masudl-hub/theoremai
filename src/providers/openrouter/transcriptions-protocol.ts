import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import type { JsonObject } from '../../kernel/json.ts';
import {
  defineProtocol,
  type Protocol,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../kernel/protocols/mod.ts';
import { openAiResponse, openAiUsageTokens } from './openai/usage.ts';

/** What an `openRouterTranscriptions` binding sets in `options`. */
export interface OpenRouterTranscriptionsOptions {
  provider?: { zdr?: boolean; data_collection?: 'allow' | 'deny' };
}

// why: OpenRouter's transcription endpoint honours these two routing fields and ignores `only`, `order`, and `ignore`, so a binding cannot set one that does nothing.
// labels-exempt: builder field description, read by the studio and docs
const options: z.ZodType<OpenRouterTranscriptionsOptions> = z.strictObject({
  provider: z
    .strictObject({
      zdr: z.boolean().optional().describe('Use only endpoints with zero data retention.'),
      data_collection: z
        .enum(['allow', 'deny'])
        .optional()
        .describe('Whether an upstream that may store and train on data can answer.'),
    })
    .optional()
    .describe('Which upstreams OpenRouter may route to. Absent: its own choice.'),
});

/** OpenRouter's word for each audio type it reads, as `input_audio.format`. */
const WIRE_FORMATS: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
};

/** The turn's one clip as OpenRouter takes it: the bytes and their format. */
function inputAudio(request: ProtocolRequest): JsonObject {
  const clips = request.input.filter((part) => part.type === 'audio');
  const [clip] = clips;
  if (clips.length !== 1 || !clip || !('data' in clip) || clip.data === undefined)
    throw new TheoremError('request', 'a transcription takes exactly one inline clip'); // labels-exempt: developer contract error
  const format = WIRE_FORMATS[clip.mimeType];
  if (!format)
    throw new TheoremError('request', `OpenRouter cannot transcribe ${clip.mimeType} audio`); // labels-exempt: developer contract error
  return { data: clip.data, format };
}

/** `/audio/transcriptions`: one clip in, its text answered whole. */
async function* transcribe(
  context: ProtocolContext<OpenRouterTranscriptionsOptions>,
  request: ProtocolRequest,
): AsyncGenerator<ProtocolEvent> {
  const parsed = options.parse(context.options ?? {});
  const body: JsonObject = {
    model: context.apiId,
    input_audio: inputAudio(request),
    ...(parsed.provider ? { provider: parsed.provider } : {}),
  };
  for await (const row of context.send(body, { stream: false })) {
    if (typeof row.text !== 'string')
      throw new TheoremError('bad_response', 'no text returned from transcription'); // labels-exempt: upstream contract error
    const response = openAiResponse(row);
    if (response) yield { type: 'response', response };
    const tokens = openAiUsageTokens(row.usage);
    if (tokens) yield { type: 'tokens', tokens };
    // why: a clip of silence is a true answer with no words, not a failure.
    if (row.text) yield { type: 'text', text: row.text };
    yield { type: 'done', stop: { kind: 'completed' } };
  }
}

/** OpenRouter's speech to text. Its body is its own JSON, not OpenAI's multipart upload. */
export const openRouterTranscriptions: Protocol<OpenRouterTranscriptionsOptions> = defineProtocol({
  id: 'openRouterTranscriptions',
  name: 'OpenRouter Transcriptions',
  description: 'OpenRouter speech-to-text models: a voice clip in, what was said out.', // labels-exempt: builder field description, read by the studio and docs
  endpoints: { transcription: '/audio/transcriptions' },
  operationNames: { transcription: 'transcribe' },
  options,
  // why: the endpoint names its answer only in this header (probed 2026-10-30), and the trace records it.
  async *framing(response) {
    const id = response.headers.get('x-generation-id')?.trim();
    yield { ...((await response.json()) as JsonObject), ...(id ? { id } : {}) };
  },
  create(context) {
    return {
      complete: (request) => transcribe(context, request),
    };
  },
});
