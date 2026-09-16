/**
 * OpenRouter provider adapter powered by Vercel AI SDK Core.
 *
 * THEORUM keeps the public `ModelProvider` and `TurnEvent` contract; AI SDK
 * owns the OpenRouter call, stream parsing, provider compatibility, and tool
 * call normalization. Message assembly delegates to `openai/sdk-messages.ts`.
 *
 * @module
 */

import { createOpenRouter, type OpenRouterChatSettings } from '@openrouter/ai-sdk-provider';
import {
  jsonSchema,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from 'ai';
import { isAbortError, TheorumError, toErrorEvent } from '../../guardrails/error.ts';
import { extractUsageTokens, parseStructuredOutput } from '../../kernel/engine/delta.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnTokens,
  WireFunctionTool,
} from '../../kernel/types.ts';
import type { OpenAiGatewayConfig } from '../types.ts';
import { cacheControlJson } from './cache-control.ts';
import { resolveOpenRouterPlugins } from './openai/chat-payload.ts';
import { openAiGatewayHeaders, resolveResponseFormat } from './openai/compat.ts';
import { buildAiSdkMessages } from './openai/sdk-messages.ts';
import { resolveOpenAiGatewayApiKey } from './resolve-api-key.ts';

export interface StreamAccumulator {
  text: string;
  evidenceSeen: boolean;
  emittedTokens: boolean;
  errored: boolean;
  finishReason?: string | null;
  nativeFinishReason?: string | null;
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
    evidenceSeen: false,
    emittedTokens: false,
    errored: false,
  };
}

export function sourceEvent(part: {
  sourceType?: string;
  title?: string | null;
  url?: string;
}): TurnEvent {
  if (part.sourceType !== 'url') {
    return {
      type: 'evidence',
      evidence: { provider: 'openrouter', raw: part as Record<string, unknown> },
    };
  }
  const title = part.title ?? part.url ?? '';
  return {
    type: 'evidence',
    evidence: {
      provider: 'openrouter',
      raw: part as Record<string, unknown>,
      citations: part.url ? [part.url] : [],
      sources: part.url ? [{ title, uri: part.url, type: 'web' as const }] : [],
    },
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

function openRouterSettings(req: ProviderCompleteRequest): OpenRouterChatSettings | undefined {
  const { plugins, webSearch } = resolveOpenRouterPlugins(req.builtins);
  if (plugins.length === 0 && !webSearch) {
    return undefined;
  }
  const settings: OpenRouterChatSettings = {};
  if (plugins.length > 0) settings.plugins = plugins as OpenRouterChatSettings['plugins'];
  if (webSearch) settings.web_search_options = {};
  return settings;
}

export function tokensFromUsage(usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  inputTokenDetails?: {
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  } | null;
  cachedInputTokens?: number | null;
}): TurnTokens | undefined {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? input + output;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? undefined;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? undefined;
  if (
    input === 0 &&
    output === 0 &&
    total === 0 &&
    !(cached && cached > 0) &&
    !(cacheWrite && cacheWrite > 0)
  ) {
    return undefined;
  }
  return {
    input,
    output,
    total,
    ...(cached && cached > 0 ? { cached } : {}),
    ...(cacheWrite && cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

export function rawRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
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
  return rawRecord(raw[key]);
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

export function evidenceFromMetadata(
  metadata: unknown,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  const raw = rawRecord(metadata);
  if (!raw || acc.evidenceSeen) {
    return undefined;
  }
  const citations = nestedCitations(raw);
  const annotations = metadataAnnotations(raw);
  if (!citations && !annotations) {
    return undefined;
  }
  acc.evidenceSeen = true;
  return {
    type: 'evidence',
    evidence: { provider: 'openrouter', raw, citations, annotations },
  };
}

export function toolArguments(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (input === undefined) {
    return undefined;
  }
  return { value: input };
}

export function toolResultData(output: unknown): Record<string, unknown> | undefined {
  return rawRecord(output);
}

export function rawThoughtEvent(raw: Record<string, unknown>): TurnEvent | undefined {
  const choices = raw.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    const delta = rawRecord(rawRecord(choice)?.delta);
    if (typeof delta?.thinking === 'string') {
      return { type: 'thought', text: delta.thinking };
    }
  }
  return undefined;
}

export function rawChoiceMessageEvidence(
  raw: Record<string, unknown>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  const choices = raw.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    const message = rawRecord(rawRecord(choice)?.message);
    if (!message) {
      continue;
    }
    const evidence = evidenceFromMetadata(message, acc);
    if (evidence) {
      return evidence;
    }
  }
  return undefined;
}

export function rawEvents(raw: unknown, acc: StreamAccumulator): TurnEvent[] {
  const record = rawRecord(raw);
  if (!record) {
    return [];
  }
  const events: TurnEvent[] = [];
  const thought = rawThoughtEvent(record);
  if (thought) {
    events.push(thought);
  }
  const evidence = evidenceFromMetadata(record, acc);
  if (evidence) {
    events.push(evidence);
  }
  const messageEvidence = rawChoiceMessageEvidence(record, acc);
  if (messageEvidence) {
    events.push(messageEvidence);
  }
  if (!acc.emittedTokens) {
    const usage = extractUsageTokens(record.usage);
    if (usage) {
      acc.emittedTokens = true;
      events.push({ type: 'tokens', tokens: usage });
    }
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    const row = rawRecord(choice);
    if (!row) continue;
    if (typeof row.finish_reason === 'string' || row.finish_reason === null) {
      acc.finishReason = row.finish_reason as string | null;
    }
    if (typeof row.native_finish_reason === 'string' || row.native_finish_reason === null) {
      acc.nativeFinishReason = row.native_finish_reason as string | null;
    }
  }
  return events;
}

export function toolCallEvent(part: {
  toolName: string;
  toolCallId: string;
  input?: unknown;
}): TurnEvent {
  return {
    type: 'tool',
    tool: {
      name: part.toolName,
      arguments: toolArguments(part.input),
      id: part.toolCallId,
    },
  };
}

export function toolResultEvent(part: {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  output?: unknown;
}): TurnEvent {
  const output = typeof part.output === 'string' ? part.output : toolResultData(part.output);
  return {
    type: 'tool',
    tool: {
      name: part.toolName,
      arguments: toolArguments(part.input),
      id: part.toolCallId,
      phase: 'complete',
      output,
    },
  };
}

export function tokenEvent(part: {
  totalUsage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    inputTokenDetails?: {
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
    } | null;
    cachedInputTokens?: number | null;
  };
}): TurnEvent | undefined {
  const tokens = tokensFromUsage(part.totalUsage);
  return tokens ? { type: 'tokens', tokens } : undefined;
}

export function providerMetadataEvent(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  if (!('providerMetadata' in part)) {
    return undefined;
  }
  return evidenceFromMetadata(part.providerMetadata, acc);
}

export function eventFromPart(part: TextStreamPart<ToolSet>, acc: StreamAccumulator): TurnEvent[] {
  const mapped = primaryEventFromPart(part, acc);
  if (mapped) {
    return [mapped];
  }
  const evidence = providerMetadataEvent(part, acc);
  return evidence ? [evidence] : [];
}

export function primaryEventFromPart(
  part: TextStreamPart<ToolSet>,
  acc: StreamAccumulator,
): TurnEvent | undefined {
  switch (part.type) {
    case 'text-delta':
      acc.text += part.text;
      return { type: 'text', text: part.text };
    case 'reasoning-delta':
      return { type: 'thought', text: part.text };
    case 'tool-call':
      return toolCallEvent(part);
    case 'tool-result':
      return toolResultEvent(part);
    case 'source': {
      if (acc.evidenceSeen) return undefined;
      acc.evidenceSeen = true;
      return sourceEvent(part);
    }
    case 'finish':
      return finishEvent(part, acc);
    case 'error':
      acc.errored = true;
      return toErrorEvent(part.error);
    default:
      return undefined;
  }
}

export function finishEvent(
  part: {
    finishReason?: string | null;
    totalUsage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      totalTokens?: number | null;
      inputTokenDetails?: {
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
      } | null;
      cachedInputTokens?: number | null;
    };
  },
  acc: StreamAccumulator,
): TurnEvent | undefined {
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
): Generator<TurnEvent> {
  if (acc.errored) {
    return;
  }
  if (req.structured && acc.text) {
    const parsed = parseStructuredOutput(acc.text);
    if (!parsed.ok) {
      yield toErrorEvent(new TheorumError(parsed.error));
      return;
    }
    yield { type: 'structured', structured: parsed.structured };
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
    fetch: config.fetch,
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

async function* yieldAiSdkStream(
  req: ProviderCompleteRequest,
  acc: StreamAccumulator,
  context: OpenRouterStreamContext,
): AsyncGenerator<TurnEvent> {
  const result = streamText(streamTextOptions(req, context));
  for await (const part of result.stream) {
    if (part.type === 'raw') {
      req.tapUpstream?.(rawRecord(part.rawValue) ?? { rawValue: part.rawValue });
      for (const event of rawEvents(part.rawValue, acc)) {
        yield event;
      }
      continue;
    }
    for (const event of eventFromPart(part, acc)) {
      yield event;
    }
  }
}

export function missingOpenRouterKey(): TurnEvent {
  return toErrorEvent('missing OpenRouter API key');
}

async function* streamOpenRouter(
  req: ProviderCompleteRequest,
  config: OpenAiGatewayConfig,
): AsyncGenerator<TurnEvent> {
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
    yield toErrorEvent(err);
  }
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
