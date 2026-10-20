import { z } from 'zod';
import { httpStatusError, TheoremError } from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';
import type { JsonObject } from '../../kernel/json.ts';
import {
  defineProtocol,
  type Protocol,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../kernel/protocols/mod.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type { ModelEvent, TurnResponse } from '../../kernel/types.ts';
import { base64ToBytes, bytesToBase64 } from '../../kernel/util/base64.ts';
import { mimeEssence } from '../../kernel/util/mime.ts';
import {
  buildChatMessages,
  resolveResponseFormat,
  wireTools,
} from '../openrouter/openai/compat.ts';
import { openAiResponse, openAiUsageTokens } from '../openrouter/openai/usage.ts';
import { pcmFormatFromMime, wrapPcmAsWav } from '../shared/pcm.ts';
import { asProtocolEvent } from '../shared/protocol-events.ts';
import { foldResponse } from '../shared/response-identity.ts';
import { structuredEvent } from '../shared/structured-output.ts';
import { toolCallEvents } from '../shared/tool-args.ts';
import { type StreamingToolCall, toolDraftEvents } from '../shared/tool-draft.ts';

/** What one reply has given so far, across its rows. */
interface Reply {
  text: string;
  finish?: string;
  native?: string;
  response?: TurnResponse;
  tokens: boolean;
  cited: Set<string>;
  calls: Map<number, StreamingToolCall>;
}

/** Old-shape events from the shared helpers, as protocol events. */
function asProtocolEvents(events: readonly ModelEvent[]): ProtocolEvent[] {
  return events.flatMap((event) => asProtocolEvent(event) ?? []);
}

function requestBody(context: ProtocolContext, request: ProtocolRequest): JsonObject {
  const stream = request.stream !== false;
  const tools = wireTools(request.wireTools);
  const format = resolveResponseFormat(request.structured);
  const body: Record<string, unknown> = {
    model: context.apiId,
    // why: replayed reasoning belongs to the protocol that wrote it, never to plain Chat Completions.
    messages: buildChatMessages(request),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    ...(request.thinking ? { reasoning_effort: request.thinking } : {}),
    ...(format ? { response_format: format } : {}),
    // probed 2026-10-09: an empty `tools` list counts as a parameter the model must support, so OpenRouter refuses models without tool calling.
    ...(tools ? { tools } : {}),
  };
  return JSON.parse(JSON.stringify(body)) as JsonObject;
}

/** An error row inside a 200 reply: thrown, so a quota refusal before any output can still fall back. */
function errorRow(row: JsonObject): void {
  const error = asRecord(row.error);
  if (!error) return;
  const status = typeof error.code === 'number' ? error.code : 502;
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
  throw httpStatusError(status, message);
}

function citations(part: Record<string, unknown>, reply: Reply): ProtocolEvent[] {
  const sources = (Array.isArray(part.annotations) ? part.annotations : []).flatMap((item) => {
    const cited = asRecord(asRecord(item)?.url_citation);
    if (typeof cited?.url !== 'string' || reply.cited.has(cited.url)) return [];
    reply.cited.add(cited.url);
    const title = typeof cited.title === 'string' && cited.title ? cited.title : cited.url;
    return [{ title, uri: cited.url, type: 'web' as const }];
  });
  return sources.length ? [{ type: 'citation', sources }] : [];
}

function mergeCalls(part: Record<string, unknown>, reply: Reply): void {
  for (const [position, value] of (Array.isArray(part.tool_calls)
    ? part.tool_calls
    : []
  ).entries()) {
    const call = asRecord(value);
    const fn = asRecord(call?.function);
    const index = typeof call?.index === 'number' ? call.index : position;
    const current = reply.calls.get(index) ?? { name: '', args: '' };
    if (typeof call?.id === 'string' && call.id) current.id = call.id;
    if (typeof fn?.name === 'string') current.name += fn.name;
    if (typeof fn?.arguments === 'string') current.args += fn.arguments;
    reply.calls.set(index, current);
  }
}

/** One choice's delta (streamed) or message (whole). */
function partEvents(
  part: Record<string, unknown>,
  reply: Reply,
  request: ProtocolRequest,
): ProtocolEvent[] {
  const events: ProtocolEvent[] = [];
  const thought = part.reasoning ?? part.reasoning_content;
  if (typeof thought === 'string' && thought && request.summaries !== 'none')
    events.push({ type: 'thought', text: thought });
  if (typeof part.content === 'string' && part.content) {
    reply.text += part.content;
    events.push({ type: 'text', text: part.content });
  }
  events.push(...citations(part, reply));
  mergeCalls(part, reply);
  return events;
}

function rowEvents(row: JsonObject, reply: Reply, request: ProtocolRequest, stream: boolean) {
  errorRow(row);
  const events: ProtocolEvent[] = [];
  const identity = foldResponse(reply.response, openAiResponse(row));
  reply.response = identity.known;
  if (identity.event) events.push(identity.event);
  const tokens = reply.tokens ? undefined : openAiUsageTokens(row.usage);
  if (tokens) {
    reply.tokens = true;
    events.push({ type: 'tokens', tokens });
  }
  for (const item of Array.isArray(row.choices) ? row.choices : []) {
    const choice = asRecord(item);
    const part = asRecord(stream ? choice?.delta : choice?.message);
    if (part) events.push(...partEvents(part, reply, request));
    if (typeof choice?.finish_reason === 'string') reply.finish = choice.finish_reason;
    // why: gateways add the upstream's own reason beside it; it tells a provider failure from a stop.
    if (typeof choice?.native_finish_reason === 'string')
      reply.native = choice.native_finish_reason;
  }
  // why: a whole reply carries each call complete; only a streamed one has a draft to show.
  if (stream)
    for (const call of reply.calls.values())
      events.push(...asProtocolEvents(toolDraftEvents(call)));
  return events;
}

/** The calls, the structured reply, and the stop, once the rows are done. */
function endEvents(reply: Reply, request: ProtocolRequest): ProtocolEvent[] {
  const events: ProtocolEvent[] = [];
  // why: some compatible servers end a tool-calling reply with `stop`, so the calls go out whatever the finish.
  for (const [index, call] of reply.calls)
    events.push(
      ...asProtocolEvents(toolCallEvents({ ...call, id: call.id ?? `call_${index}` }, call.args)),
    );
  const stop = turnStopFromOpenAiFinishReason(reply.finish, reply.native);
  if (request.structured && reply.text && stop.kind === 'completed') {
    const structured = asProtocolEvents([structuredEvent(reply.text) as ModelEvent]);
    events.push(...structured);
    if (structured[0]?.type === 'error') return events;
  }
  events.push({ type: 'done', stop });
  return events;
}

/** `/audio/speech`: the input's text read aloud, answered whole. Raw PCM with a stated rate becomes WAV. */
async function* speech(
  context: ProtocolContext,
  request: ProtocolRequest,
): AsyncGenerator<ProtocolEvent> {
  const text = request.input
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .trim();
  if (!text) throw new TheoremError('request', 'empty text for speech');
  const spec = request.speech;
  const body: JsonObject = {
    model: context.apiId,
    input: text,
    ...(spec?.format ? { response_format: spec.format } : {}),
    ...(spec?.voice ? { voice: spec.voice } : {}),
    ...(spec?.speed === undefined ? {} : { speed: spec.speed }),
    // why: `instructions` is the endpoint's own field for delivery, never read aloud (probe 07/10/2026: Gemini 3.8 slowed and sped by it).
    ...(spec?.style ? { instructions: spec.style } : {}),
  };
  for await (const row of context.send(body, { stream: false })) {
    const type = typeof row.mime_type === 'string' ? row.mime_type : '';
    const bytes = typeof row.data === 'string' ? base64ToBytes(row.data) : new Uint8Array();
    if (!bytes.length) throw new TheoremError('bad_response', 'no audio returned from speech');
    const pcm = pcmFormatFromMime(type);
    const media = pcm
      ? { mimeType: 'audio/wav', data: bytesToBase64(wrapPcmAsWav(bytes, pcm)) }
      : { mimeType: mimeEssence(type) || 'application/octet-stream', data: row.data as string };
    yield { type: 'media', media };
    // why: the endpoint answers whole or not at all: a body with audio completed.
    yield { type: 'done', stop: { kind: 'completed' } };
  }
}

/** OpenAI Chat Completions: the shape most compatible servers speak. */
export const openAi: Protocol<Record<string, never>> = defineProtocol({
  id: 'openAi',
  name: 'OpenAI Chat Completions',
  description: 'The Chat Completions shape that OpenAI and most compatible servers speak.', // labels-exempt: builder field description, read by the studio and docs
  endpoints: { text: '/chat/completions', speech: '/audio/speech' },
  options: z.strictObject({}),
  create(context) {
    return {
      async *complete(request) {
        if (context.profileType === 'speech') {
          yield* speech(context, request);
          return;
        }
        const stream = request.stream !== false;
        const reply: Reply = { text: '', tokens: false, cited: new Set(), calls: new Map() };
        for await (const row of context.send(requestBody(context, request), { stream }))
          yield* rowEvents(row, reply, request, stream);
        yield* endEvents(reply, request);
      },
    };
  },
});
