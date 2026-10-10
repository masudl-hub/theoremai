import { OpenRouter } from '@openrouter/sdk';
import { HTTPClient } from '@openrouter/sdk/lib/http.js';
import type { ChatRequest } from '@openrouter/sdk/models/chatrequest.js';
import { ChatRequest$outboundSchema } from '@openrouter/sdk/models/chatrequest.js';
import {
  isAbortError,
  kindOfHttpStatus,
  TheoremError,
  toErrorEvent,
} from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  ProviderEvent,
  Source,
  TurnEventOf,
  TurnResponse,
} from '../../kernel/types.ts';
import { builtinWire } from '../shared/builtin-wire.ts';
import { foldResponse } from '../shared/response-identity.ts';
import { readSseChunks } from '../shared/sse.ts';
import { structuredEvent } from '../shared/structured-output.ts';
import { historyToolArguments, toolCallEvents } from '../shared/tool-args.ts';
import { networkFetch } from '../shared/upstream-tap.ts';
import type { OpenAiGatewayTransport } from '../types.ts';
import { cacheControlJson } from './cache-control.ts';
import { buildChatMessages, resolveResponseFormat } from './openai/compat.ts';
import { openAiResponse, openAiUsageTokens } from './openai/usage.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';
import { openRouterFetch } from './transport.ts';

interface StreamAccumulator {
  text: string;
  citedUris: Set<string>;
  reportedAnnotations: Set<string>;
  emittedTokens: boolean;
  errored: boolean;
  finishReason?: string | null;
  nativeFinishReason?: string | null;
  response?: TurnResponse;
}
function createAccumulator(): StreamAccumulator {
  return {
    text: '',
    citedUris: new Set(),
    reportedAnnotations: new Set(),
    emittedTokens: false,
    errored: false,
  };
}
function webSource(uri: string, title?: string | null): Source {
  return { title: title || uri, uri, type: 'web' };
}

function citationEvent(
  sources: readonly Source[],
  acc: StreamAccumulator,
): TurnEventOf<'citation'> | undefined {
  const fresh: Source[] = [];
  for (const source of sources) {
    if (acc.citedUris.has(source.uri)) continue;
    acc.citedUris.add(source.uri);
    fresh.push(source);
  }
  return fresh.length > 0 ? { type: 'citation', sources: fresh } : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length > 0 ? out : undefined;
}

function metadataRecord(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(raw[key]);
}

function citationCandidates(raw: Record<string, unknown>): unknown[] {
  const openrouter = metadataRecord(raw, 'openrouter') ?? {};
  return [
    raw.citations,
    metadataRecord(raw, 'providerMetadata')?.citations,
    metadataRecord(raw, 'provider_metadata')?.citations,
    openrouter.citations,
    metadataRecord(openrouter, 'providerMetadata')?.citations,
    metadataRecord(openrouter, 'provider_metadata')?.citations,
  ];
}

function nestedCitations(raw: Record<string, unknown>): string[] | undefined {
  for (const candidate of citationCandidates(raw)) {
    const citations = stringArray(candidate);
    if (citations) {
      return citations;
    }
  }
  return undefined;
}

function metadataAnnotations(raw: Record<string, unknown>): unknown[] | undefined {
  const openrouter = metadataRecord(raw, 'openrouter');
  if (Array.isArray(raw.annotations)) {
    return raw.annotations;
  }
  if (Array.isArray(openrouter?.annotations)) {
    return openrouter.annotations;
  }
  return undefined;
}

function annotationSource(annotation: unknown): Source | undefined {
  const record = asRecord(annotation);
  const cited = asRecord(record?.url_citation);
  if (record?.type !== 'url_citation' || typeof cited?.url !== 'string') {
    return undefined;
  }
  return webSource(cited.url, typeof cited.title === 'string' ? cited.title : undefined);
}

/** Each citation or annotation reports once per call, however many rows repeat it. */
function eventsFromMetadata(metadata: unknown, acc: StreamAccumulator): ProviderEvent[] {
  const raw = asRecord(metadata);
  if (!raw) {
    return [];
  }
  const annotations = metadataAnnotations(raw) ?? [];
  const sources = (nestedCitations(raw) ?? []).map((uri) => webSource(uri));
  const other: unknown[] = [];
  for (const annotation of annotations) {
    const source = annotationSource(annotation);
    if (source) {
      sources.push(source);
      continue;
    }
    const key = String(JSON.stringify(annotation));
    if (acc.reportedAnnotations.has(key)) continue;
    acc.reportedAnnotations.add(key);
    other.push(annotation);
  }
  const events: ProviderEvent[] = [];
  const citation = citationEvent(sources, acc);
  if (citation) {
    events.push(citation);
  }
  if (other.length > 0) {
    events.push({
      type: 'evidence',
      evidence: {
        provider: 'openrouter',
        kind: 'provider_step',
        step: 'annotations',
        raw: { annotations: other },
      },
    });
  }
  return events;
}

function rawThoughtEvent(raw: Record<string, unknown>): ProviderEvent | undefined {
  const choices = raw.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    const delta = asRecord(asRecord(choice)?.delta);
    if (typeof delta?.thinking === 'string') {
      return { type: 'thought', text: delta.thinking };
    }
  }
  return undefined;
}

function rawChoiceMessageEvents(
  raw: Record<string, unknown>,
  acc: StreamAccumulator,
): ProviderEvent[] {
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  return choices.flatMap((choice) => eventsFromMetadata(asRecord(choice)?.message, acc));
}

function rawEvents(raw: unknown, acc: StreamAccumulator): ProviderEvent[] {
  const record = asRecord(raw);
  if (!record) {
    return [];
  }
  const identity = foldResponse(acc.response, openAiResponse(record));
  acc.response = identity.known;
  const events: ProviderEvent[] = identity.event ? [identity.event] : [];
  const thought = rawThoughtEvent(record);
  if (thought) {
    events.push(thought);
  }
  events.push(...eventsFromMetadata(record, acc), ...rawChoiceMessageEvents(record, acc));
  if (!acc.emittedTokens) {
    const usage = openAiUsageTokens(record.usage);
    if (usage) {
      acc.emittedTokens = true;
      events.push({ type: 'tokens', tokens: usage });
    }
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    const row = asRecord(choice);
    if (!row) continue;
    if (typeof row.finish_reason === 'string' || row.finish_reason === null) {
      if (row.finish_reason) acc.finishReason = row.finish_reason;
    }
    if (typeof row.native_finish_reason === 'string' || row.native_finish_reason === null) {
      if (row.native_finish_reason) acc.nativeFinishReason = row.native_finish_reason;
    }
  }
  return events;
}

function wireRequest(req: ProviderCompleteRequest): Record<string, unknown> {
  const messages = buildChatMessages(req);
  if (req.cache?.mode === 'system' && messages[0]?.role === 'system') {
    messages[0].content = [
      { type: 'text', text: req.system, cache_control: cacheControlJson(req.cache) },
    ];
  }
  const plugins: Array<{ id: string }> = [];
  let web = false;
  for (const builtin of req.builtins) {
    const id = builtinWire(builtin, 'openRouter');
    if (id === 'web') web = true;
    else plugins.push({ id });
  }
  const wire = {
    model: req.apiId,
    messages,
    stream: req.stream !== false,
    stream_options: req.stream === false ? undefined : { include_usage: true },
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
    tools: req.wireTools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: 'object', properties: {}, additionalProperties: true },
      },
    })),
    reasoning: req.thinking ? { effort: req.thinking } : undefined,
    response_format: resolveResponseFormat(req.structured),
    provider: { require_parameters: true },
    cache_control: req.cache?.mode === 'automatic' ? cacheControlJson(req.cache) : undefined,
    session_id: req.sessionId,
    plugins: plugins.length ? plugins : undefined,
    web_search_options: web ? {} : undefined,
  };
  return wire;
}

function sdkFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sdkFields);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      key === 'parameters' || key === 'schema' ? item : sdkFields(item),
    ]),
  );
}
function chatRequest(req: ProviderCompleteRequest): ChatRequest {
  const wire = wireRequest(req);
  const messages = wire.messages as Array<Record<string, unknown>>;
  wire.messages = messages.map(
    ({ reasoning_details: _details, reasoning: _reasoning, ...message }) => message,
  );
  const input = sdkFields(wire) as ChatRequest;
  ChatRequest$outboundSchema.parse(input);
  return input;
}

function mergeToolDeltas(
  delta: Record<string, unknown>,
  pending: Map<number, { id?: string; name: string; args: string }>,
): void {
  if (Array.isArray(delta.tool_calls)) {
    for (const [i, value] of delta.tool_calls.entries()) {
      const call = asRecord(value);
      const fn = asRecord(call?.function);
      const index = typeof call?.index === 'number' ? call.index : i;
      const current = pending.get(index) ?? { name: '', args: '' };
      if (typeof call?.id === 'string') current.id = call.id;
      if (typeof fn?.name === 'string') current.name += fn.name;
      if (typeof fn?.arguments === 'string') current.args += fn.arguments;
      pending.set(index, current);
    }
  }
}

function decodeRow(
  raw: Record<string, unknown>,
  acc: StreamAccumulator,
  pending: Map<number, { id?: string; name: string; args: string }>,
  buffered: boolean,
): ProviderEvent[] {
  const error = asRecord(raw.error);
  if (error) {
    acc.errored = true;
    return [
      toErrorEvent(
        new TheoremError(
          typeof error.code === 'number' ? kindOfHttpStatus(error.code) : 'unavailable',
          String(error.message ?? 'Provider stream failed'),
        ),
      ),
    ];
  }
  const events = rawEvents(raw, acc);
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  for (const item of choices) {
    const choice = asRecord(item);
    const delta = asRecord(buffered ? choice?.message : choice?.delta);
    if (!delta) continue;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      acc.text += delta.content;
      events.push({ type: 'text', text: delta.content });
    }
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === 'string') events.push({ type: 'thought', text: reasoning });
    mergeToolDeltas(delta, pending);
  }
  return events;
}

async function sdkRequestBody(
  request: Request,
  req: ProviderCompleteRequest,
): Promise<Record<string, unknown>> {
  // why: Preserve service extensions not yet represented by the generated SDK schema.
  const body = asRecord(await request.json());
  if (!body) throw new TheoremError('bad_response', 'SDK request body is not an object');
  const extensions = wireRequest(req);
  const originals = extensions.messages as Array<Record<string, unknown>>;
  if (Array.isArray(body.messages))
    for (const [index, message] of body.messages.entries()) {
      if (originals[index]?.name !== undefined) message.name = originals[index].name;
      if (originals[index]?.reasoning_details !== undefined)
        message.reasoning_details = originals[index].reasoning_details;
      if (originals[index]?.reasoning !== undefined) message.reasoning = originals[index].reasoning;
    }
  if (extensions.web_search_options) body.web_search_options = extensions.web_search_options;
  return body;
}

function normalizeSdkError(error: unknown): TheoremError {
  const status = asRecord(error)?.statusCode;
  let underlying: unknown = error;
  for (let depth = 0; depth < 8 && underlying instanceof Error && underlying.cause; depth++) {
    if (underlying instanceof TheoremError) break;
    underlying = underlying.cause;
  }
  return underlying instanceof TheoremError
    ? underlying
    : typeof status === 'number'
      ? new TheoremError(kindOfHttpStatus(status), 'Provider request failed')
      : new TheoremError(
          underlying instanceof TypeError ? 'network' : 'bad_response',
          'Provider response failed',
        );
}

async function drainSdkStream(
  parsed: unknown,
  onReader: (reader: ReadableStreamDefaultReader<unknown> | undefined) => void,
): Promise<unknown> {
  try {
    if (parsed instanceof ReadableStream) {
      const reader = parsed.getReader();
      onReader(reader);
      try {
        while (!(await reader.read()).done) {
          // why: Drain SDK validation while the raw branch preserves native fields.
        }
      } finally {
        reader.releaseLock();
        onReader(undefined);
      }
    }

    return undefined;
  } catch (error) {
    return error;
  }
}

function sdkResponseRow(value: unknown): Record<string, unknown> {
  const row = asRecord(value);
  if (!row) throw new TheoremError('bad_response', 'Invalid provider payload');
  if (row.eventType === 'sse_done') return row;
  if (row.eventType === 'sse_unparsed' || (!Array.isArray(row.choices) && !row.error))
    throw new TheoremError('bad_response', 'Invalid provider payload');
  return row;
}

async function* streamOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenAiGatewayTransport,
): AsyncGenerator<ProviderEvent> {
  const acc = createAccumulator();
  let rawResponse: Response | undefined;
  let sdkReader: ReadableStreamDefaultReader<unknown> | undefined;
  try {
    const key = resolveOpenAiGatewayApiKey(config, req.keySlot);
    const send = networkFetch(openRouterFetch(req, config, key));
    const client = new OpenRouter({
      apiKey: key,
      serverURL: config.baseUrl ?? 'https://openrouter.ai/api/v1',
      httpReferer: config.siteUrl,
      appTitle: config.siteName,
      retryConfig: { strategy: 'none' },
      debugLogger: { group() {}, groupEnd() {}, log() {} },
      httpClient: new HTTPClient({
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          if (config.siteName) request.headers.set('X-Title', config.siteName);
          const body = await sdkRequestBody(request, req);
          const response = await send(request.url, {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            body: JSON.stringify(body),
          });
          // why: The SDK strips unknown metadata; the raw branch preserves citations and native state.
          rawResponse = response.clone();
          return response;
        },
      }),
    });
    const parsed = await client.chat.send(
      { chatRequest: chatRequest(req) },
      { signal: req.signal },
    );
    const validation = drainSdkStream(parsed, (reader) => {
      sdkReader = reader;
    });
    const raw = rawResponse;
    if (!raw?.body) throw new TheoremError('bad_response', 'Provider returned no response body');
    const pending = new Map<number, { id?: string; name: string; args: string }>();
    const rows = req.stream === false ? [await raw.json()] : readSseChunks(raw.body);
    for await (const value of rows) {
      const row = sdkResponseRow(value);
      if (row.eventType === 'sse_done') break;
      req.tapUpstream?.(row);
      for (const event of decodeRow(row, acc, pending, req.stream === false)) {
        if (event.type !== 'thought' || req.summaries !== 'none') yield event;
      }
      if (acc.errored) break;
    }
    const invalid = await validation;
    if (invalid) throw invalid;
    if (acc.errored) return;
    const stop = turnStopFromOpenAiFinishReason(acc.finishReason, acc.nativeFinishReason);
    if (stop.kind === 'tool')
      for (const call of pending.values()) {
        if (!call.id || !call.name)
          throw new TheoremError('bad_response', 'Incomplete tool identity');
        historyToolArguments(call.args);
        yield* toolCallEvents(call, call.args);
      }
    if (req.structured && acc.text) {
      const event = structuredEvent(acc.text);
      yield event;
      if (event.type === 'error') return;
    }
    yield { type: 'done', stop };
  } catch (error) {
    if (isAbortError(error)) throw error;
    const normalized = normalizeSdkError(error);
    yield toErrorEvent(normalized);
  } finally {
    await Promise.allSettled([sdkReader?.cancel(), rawResponse?.body?.cancel()]);
  }
}
export function createOpenRouterProvider(config: OpenAiGatewayTransport = {}): ModelProvider {
  return { complete: (req) => streamOpenRouter(req, config) };
}
