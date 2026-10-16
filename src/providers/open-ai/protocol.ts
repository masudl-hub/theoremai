import { z } from 'zod';
import { kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';
import {
  defineProtocol,
  type ProtocolContext,
  type ProtocolEvent,
  type TurnRequest,
} from '../../kernel/protocols/mod.ts';
import type { JsonObject } from '../../kernel/provider-contract.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type { ProviderCompleteRequest, ProviderEvent, TurnResponse } from '../../kernel/types.ts';
import {
  buildChatMessages,
  resolveResponseFormat,
  wireTools,
} from '../openrouter/openai/compat.ts';
import { openAiResponse, openAiUsageTokens } from '../openrouter/openai/usage.ts';
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
function asProtocolEvents(events: readonly ProviderEvent[]): ProtocolEvent[] {
  return events.flatMap((event): ProtocolEvent[] => {
    if (event.type !== 'tool') return [event as ProtocolEvent];
    if (event.tool.phase === undefined) return [{ type: 'tool_call', call: event.tool }];
    return event.tool.phase === 'error' ? [{ type: 'error', errorKind: 'bad_response' }] : [];
  });
}

function requestBody(context: ProtocolContext, request: TurnRequest): JsonObject {
  const stream = request.stream !== false;
  const tools = wireTools(request.wireTools);
  const format = resolveResponseFormat(request.structured);
  const body: Record<string, unknown> = {
    model: context.apiId,
    // why: replayed reasoning belongs to the protocol that wrote it, never to plain Chat Completions.
    messages: buildChatMessages({ ...request, state: undefined } as ProviderCompleteRequest),
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
  throw new TheoremError(kindOfHttpStatus(status), message);
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
  request: TurnRequest,
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

function rowEvents(row: JsonObject, reply: Reply, request: TurnRequest, stream: boolean) {
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

/** The calls, the structured reply and the stop, once the rows are done. */
function endEvents(reply: Reply, request: TurnRequest): ProtocolEvent[] {
  const events: ProtocolEvent[] = [];
  // why: some compatible servers end a tool-calling reply with `stop`, so the calls go out whatever the finish.
  for (const [index, call] of reply.calls)
    events.push(
      ...asProtocolEvents(toolCallEvents({ ...call, id: call.id ?? `call_${index}` }, call.args)),
    );
  const stop = turnStopFromOpenAiFinishReason(reply.finish, reply.native);
  if (request.structured && reply.text && stop.kind === 'completed') {
    const structured = asProtocolEvents([structuredEvent(reply.text) as ProviderEvent]);
    events.push(...structured);
    if (structured[0]?.type === 'error') return events;
  }
  events.push({ type: 'done', stop });
  return events;
}

/** OpenAI Chat Completions: the shape most compatible servers speak. */
export const openAi = defineProtocol({
  id: 'openAi',
  name: 'OpenAI Chat Completions',
  description: 'The Chat Completions shape that OpenAI and most compatible servers speak.', // labels-exempt: builder field description, read by the studio and docs
  endpoints: { text: '/chat/completions' },
  options: z.strictObject({}),
  create(context) {
    return {
      async *complete(request) {
        const stream = request.stream !== false;
        const reply: Reply = { text: '', tokens: false, cited: new Set(), calls: new Map() };
        for await (const row of context.send(requestBody(context, request), { stream }))
          yield* rowEvents(row, reply, request, stream);
        yield* endEvents(reply, request);
      },
    };
  },
});
