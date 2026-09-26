/**
 * OpenRouter provider adapter powered by Vercel AI SDK Core.
 *
 * THEOREM keeps the public `ModelProvider` and `ProviderEvent` contract; AI SDK
 * owns the OpenRouter call, stream parsing, provider compatibility, and tool
 * call normalization. Message assembly delegates to `openai/sdk-messages.ts`.
 *
 * @module
 */

import { createOpenRouter, type OpenRouterChatSettings } from '@openrouter/ai-sdk-provider';
import {
  AISDKError,
  APICallError,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  RetryError,
  StreamProviderError,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from 'ai';
import {
  isAbortError,
  kindOfHttpStatus,
  TheoremError,
  toErrorEvent,
} from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';
import { reportedTokens, usageCount } from '../../kernel/engine/usage.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  ProviderEvent,
  Source,
  TurnEventOf,
  TurnResponse,
  TurnTokens,
  WireFunctionTool,
} from '../../kernel/types.ts';
import { builtinWire } from '../shared/builtin-wire.ts';
import { foldResponse } from '../shared/response-identity.ts';
import { structuredEvent } from '../shared/structured-output.ts';
import { malformedToolCall, toolCallEvents } from '../shared/tool-args.ts';
import { networkError, tapFetch } from '../shared/upstream-tap.ts';
import type { OpenAiGatewayConfig } from '../types.ts';
import { cacheControlJson } from './cache-control.ts';
import { openAiGatewayHeaders, resolveResponseFormat } from './openai/compat.ts';
import { buildAiSdkMessages } from './openai/sdk-messages.ts';
import { openAiResponse, openAiUsageTokens } from './openai/usage.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';

export interface StreamAccumulator {
  text: string;
  /** URIs this call has cited: a source cites once, whichever channel names it first. */
  citedUris: Set<string>;
  /** Other annotations reported, by their JSON: raw rows and the SDK's metadata repeat them. */
  reportedAnnotations: Set<string>;
  emittedTokens: boolean;
  errored: boolean;
  finishReason?: string | null;
  nativeFinishReason?: string | null;
  /** Response identity the raw rows named so far (`id`, `model`). */
  response?: TurnResponse;
}

interface OpenRouterStreamContext {
  openrouter: ReturnType<typeof createOpenRouter>;
  modelName: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export type ProviderOptions = Record<string, { [key: string]: JsonValue }>;

export function trimApiKey(explicitKey?: string): string | undefined {
  if (explicitKey?.trim()) {
    return explicitKey.trim();
  }
  return undefined;
}

export function createAccumulator(): StreamAccumulator {
  return {
    text: '',
    citedUris: new Set(),
    reportedAnnotations: new Set(),
    emittedTokens: false,
    errored: false,
  };
}

export type SourcePart = Extract<TextStreamPart<ToolSet>, { type: 'source' }>;

function webSource(uri: string, title?: string | null): Source {
  return { title: title || uri, uri, type: 'web' };
}

/** A `citation` of the sources this call has not cited yet; none when every one was. */
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

/** An AI SDK `source` part: a URL cites; any other source is a `provider_step`. */
export function sourceEvent(part: SourcePart, acc: StreamAccumulator): ProviderEvent | undefined {
  if (part.sourceType === 'url') {
    return citationEvent([webSource(part.url, part.title)], acc);
  }
  return {
    type: 'evidence',
    evidence: { provider: 'openrouter', kind: 'provider_step', step: 'source', raw: { ...part } },
  };
}

export function schemaForTool(decl: WireFunctionTool): Record<string, unknown> {
  return decl.parameters ?? { type: 'object', properties: {}, additionalProperties: true };
}

export function buildTools(wireTools?: WireFunctionTool[]): ToolSet | undefined {
  if (!wireTools || wireTools.length === 0) {
    return undefined;
  }
  const tools: ToolSet = {};
  for (const decl of wireTools) {
    tools[decl.name] = tool({
      description: decl.description,
      inputSchema: jsonSchema(schemaForTool(decl)),
    });
  }
  return tools;
}

/** Builtins as OpenRouter wires them: `web` is `web_search_options`, every other wire a plugin. */
function openRouterSettings(req: ProviderCompleteRequest): OpenRouterChatSettings | undefined {
  let webSearch = false;
  const plugins: Array<{ id: string }> = [];
  for (const builtin of req.builtins) {
    const pluginId = builtinWire(builtin, 'openRouter');
    if (pluginId === 'web') webSearch = true;
    else plugins.push({ id: pluginId });
  }
  if (plugins.length === 0 && !webSearch) {
    return undefined;
  }
  const settings: OpenRouterChatSettings = {};
  if (plugins.length > 0) {
    settings.plugins = plugins as OpenRouterChatSettings['plugins'];
  }
  if (webSearch) settings.web_search_options = {};
  return settings;
}

/**
 * AI SDK `totalUsage` → `TurnTokens`. Used only when the raw OpenRouter stream
 * carried no `usage` row (`rawEvents` reads that one first, with cost).
 */
export function tokensFromUsage(usage: LanguageModelUsage): TurnTokens | undefined {
  return reportedTokens({
    input: usageCount(usage.inputTokens),
    output: usageCount(usage.outputTokens),
    thinking: usageCount(usage.outputTokenDetails?.reasoningTokens),
    cached: usageCount(usage.inputTokenDetails?.cacheReadTokens),
    cacheWrite: usageCount(usage.inputTokenDetails?.cacheWriteTokens),
  });
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length > 0 ? out : undefined;
}

export function metadataRecord(
  raw: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(raw[key]);
}

export function citationCandidates(raw: Record<string, unknown>): unknown[] {
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

export function nestedCitations(raw: Record<string, unknown>): string[] | undefined {
  for (const candidate of citationCandidates(raw)) {
    const citations = stringArray(candidate);
    if (citations) {
      return citations;
    }
  }
  return undefined;
}

export function metadataAnnotations(raw: Record<string, unknown>): unknown[] | undefined {
  const openrouter = metadataRecord(raw, 'openrouter');
  if (Array.isArray(raw.annotations)) {
    return raw.annotations;
  }
  if (Array.isArray(openrouter?.annotations)) {
    return openrouter.annotations;
  }
  return undefined;
}

/** A `url_citation` annotation's source. */
function annotationSource(annotation: unknown): Source | undefined {
  const record = asRecord(annotation);
  const cited = asRecord(record?.url_citation);
  if (record?.type !== 'url_citation' || typeof cited?.url !== 'string') {
    return undefined;
  }
  return webSource(cited.url, typeof cited.title === 'string' ? cited.title : undefined);
}

/**
 * A metadata record's citations and annotations: URLs as one `citation`, any
 * other annotation (a parsed file, say) as `provider_step` evidence. Each
 * reports once per call, however many rows repeat it.
 */
export function eventsFromMetadata(metadata: unknown, acc: StreamAccumulator): ProviderEvent[] {
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

export function rawThoughtEvent(raw: Record<string, unknown>): ProviderEvent | undefined {
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

/** Citations and annotations on a buffered reply's `choices[].message`. */
export function rawChoiceMessageEvents(
  raw: Record<string, unknown>,
  acc: StreamAccumulator,
): ProviderEvent[] {
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  return choices.flatMap((choice) => eventsFromMetadata(asRecord(choice)?.message, acc));
}

export function rawEvents(raw: unknown, acc: StreamAccumulator): ProviderEvent[] {
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
      acc.finishReason = row.finish_reason;
    }
    if (typeof row.native_finish_reason === 'string' || row.native_finish_reason === null) {
      acc.nativeFinishReason = row.native_finish_reason;
    }
  }
  return events;
}

export type ToolCallPart = Extract<TextStreamPart<ToolSet>, { type: 'tool-call' }>;

/**
 * The model's call, through the shared call rule (`toolCallEvents`). A call
 * the SDK could not parse or match to a tool is the call with no arguments,
 * then its failure carrying what the model sent.
 */
export function toolCallPartEvents(part: ToolCallPart): ProviderEvent[] {
  if (part.invalid) {
    const message = part.error instanceof Error ? part.error.message : 'tool call was not valid';
    return malformedToolCall({ name: part.toolName, callId: part.toolCallId }, message, part.input);
  }
  return toolCallEvents({ id: part.toolCallId, name: part.toolName }, part.input);
}

export function tokenEvent(part: { totalUsage: LanguageModelUsage }): ProviderEvent | undefined {
  const tokens = tokensFromUsage(part.totalUsage);
  return tokens ? { type: 'tokens', tokens } : undefined;
}

export function providerMetadataEvents(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): ProviderEvent[] {
  return 'providerMetadata' in part ? eventsFromMetadata(part.providerMetadata, acc) : [];
}

/** A stream part's own events, then what its provider metadata cites. */
export function eventFromPart(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): ProviderEvent[] {
  return [...primaryEventsFromPart(part, acc), ...providerMetadataEvents(part, acc)];
}

export function primaryEventsFromPart(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): ProviderEvent[] {
  switch (part.type) {
    case 'text-delta':
      acc.text += part.text;
      return [{ type: 'text', text: part.text }];
    case 'reasoning-delta':
      return [{ type: 'thought', text: part.text }];
    case 'tool-call':
      return toolCallPartEvents(part);
    case 'source': {
      const event = sourceEvent(part, acc);
      return event ? [event] : [];
    }
    case 'finish': {
      const event = finishEvent(part, acc);
      return event ? [event] : [];
    }
    case 'error':
      acc.errored = true;
      return [toErrorEvent(streamPartError(part.error))];
    default:
      return [];
  }
}

export function finishEvent(
  part: { finishReason?: string | null; totalUsage?: LanguageModelUsage },
  acc: StreamAccumulator,
): ProviderEvent | undefined {
  if (part.finishReason != null) {
    acc.finishReason = String(part.finishReason);
  }
  if (acc.emittedTokens) {
    return undefined;
  }
  if (!part.totalUsage) {
    return undefined;
  }
  const event = tokenEvent({ totalUsage: part.totalUsage });
  if (event) {
    acc.emittedTokens = true;
  }
  return event;
}

export function* finalEvents(
  req: ProviderCompleteRequest,
  acc: StreamAccumulator,
): Generator<ProviderEvent> {
  if (acc.errored) {
    return;
  }
  if (req.structured && acc.text) {
    const event = structuredEvent(acc.text);
    yield event;
    if (event.type === 'error') return;
  }
  yield {
    type: 'done',
    stop: turnStopFromOpenAiFinishReason(acc.finishReason, acc.nativeFinishReason),
  };
}

function createStreamContext(
  req: ProviderCompleteRequest,
  config: OpenAiGatewayConfig,
  apiKey: string,
): OpenRouterStreamContext {
  const openrouter = createOpenRouter({
    apiKey,
    baseURL: config.baseUrl,
    headers: openAiGatewayHeaders(config),
    // The AI SDK retries internally; tapping its fetch tapes every try.
    fetch: tapFetch(req.tapUpstream, config.fetch ?? fetch, req.keySlot),
    compatibility: 'strict',
  });
  return {
    openrouter,
    modelName: req.apiId,
  };
}

/** System via instructions XOR a cache-marked system message — never both. */
export function systemDelivery(req: ProviderCompleteRequest): {
  instructions?: string;
  systemMessage?: ModelMessage;
} {
  if (!req.system) {
    return {};
  }
  if (req.cache?.mode === 'system') {
    return {
      systemMessage: {
        role: 'system',
        content: req.system,
        providerOptions: {
          openrouter: { cacheControl: cacheControlJson(req.cache) },
        },
      } as ModelMessage,
    };
  }
  return { instructions: req.system };
}

function streamTextOptions(
  req: ProviderCompleteRequest,
  context: OpenRouterStreamContext,
): Parameters<typeof streamText>[0] {
  const delivery = systemDelivery(req);
  const messages = buildAiSdkMessages(req);
  if (delivery.systemMessage) {
    messages.unshift(delivery.systemMessage);
  }
  return {
    model: context.openrouter.chat(context.modelName, openRouterSettings(req)),
    instructions: delivery.instructions,
    messages,
    allowSystemInMessages: true,
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
    tools: buildTools(req.wireTools),
    providerOptions: providerOptionsFor(req),
    include: { rawChunks: true },
    abortSignal: req.signal,
    onError: () => undefined,
  };
}

function shouldEmitProviderEvent(req: ProviderCompleteRequest, event: ProviderEvent): boolean {
  return event.type !== 'thought' || req.summaries !== 'none';
}

async function* yieldAiSdkStream(
  req: ProviderCompleteRequest,
  acc: StreamAccumulator,
  context: OpenRouterStreamContext,
): AsyncGenerator<ProviderEvent> {
  const result = streamText(streamTextOptions(req, context));
  for await (const part of result.stream) {
    if (part.type === 'raw') {
      req.tapUpstream?.(asRecord(part.rawValue) ?? { rawValue: part.rawValue });
      for (const event of rawEvents(part.rawValue, acc)) {
        if (shouldEmitProviderEvent(req, event)) {
          yield event;
        }
      }
      continue;
    }
    for (const event of eventFromPart(part, acc)) {
      if (shouldEmitProviderEvent(req, event)) {
        yield event;
      }
    }
  }
}

async function* streamOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenAiGatewayConfig,
): AsyncGenerator<ProviderEvent> {
  let apiKey: string;
  try {
    apiKey = resolveOpenAiGatewayApiKey(config, req.keySlot);
  } catch (err) {
    yield toErrorEvent(err);
    return;
  }

  const acc = createAccumulator();
  const context = createStreamContext(req, config, apiKey);
  try {
    yield* yieldAiSdkStream(req, acc, context);
    yield* finalEvents(req, acc);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    yield toErrorEvent(sdkError(err));
  }
}

/**
 * An AI SDK failure with its kind. A failure that carries OpenRouter's HTTP
 * status (a call's response, or an error sent mid-stream) reports that
 * status; a call that got no response could not reach OpenRouter; a
 * mid-stream error without a status is OpenRouter's own; any other SDK error
 * is a reply the SDK could not read. Retries report their last failure.
 */
function sdkError(err: unknown): unknown {
  if (RetryError.isInstance(err)) {
    return sdkError(err.lastError);
  }
  if (!AISDKError.isInstance(err)) {
    return err;
  }
  const status = asRecord(err)?.statusCode;
  const kind =
    typeof status === 'number'
      ? kindOfHttpStatus(status)
      : APICallError.isInstance(err)
        ? 'network'
        : StreamProviderError.isInstance(err)
          ? 'unavailable'
          : 'bad_response';
  return new TheoremError(kind, err.message, { cause: err });
}

/**
 * A stream's error part with its kind. Besides SDK errors, a body that breaks
 * mid-read arrives as a plain error: OpenRouter could not be reached.
 */
function streamPartError(error: unknown): unknown {
  return AISDKError.isInstance(error) || RetryError.isInstance(error)
    ? sdkError(error)
    : networkError(error);
}

export function providerOptionsFor(req: ProviderCompleteRequest): ProviderOptions | undefined {
  const openrouter: Record<string, JsonValue> = {};
  if (req.thinking && req.thinking !== 'none') {
    openrouter.reasoning = { effort: req.thinking };
  }
  const responseFormat = resolveResponseFormat(req.structured) as
    | Record<string, JsonValue>
    | undefined;
  if (responseFormat) {
    openrouter.response_format = responseFormat;
    // Route only to endpoints that honour the schema; one that ignores it answers in prose.
    openrouter.provider = { require_parameters: true };
  }
  if (req.cache?.mode === 'automatic') {
    openrouter.cacheControl = cacheControlJson(req.cache);
  }
  if (req.sessionId) {
    openrouter.session_id = req.sessionId;
  }
  if (Object.keys(openrouter).length === 0) return undefined;
  return { openrouter } as ProviderOptions;
}

/** Create a `ModelProvider` backed by OpenRouter through AI SDK Core. */
export function createOpenRouterProvider(config: OpenAiGatewayConfig = {}): ModelProvider {
  return {
    complete: (req: ProviderCompleteRequest) => streamOpenRouter(req, config),
  };
}

export type { OpenAiGatewayConfig };
