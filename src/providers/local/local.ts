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
  TurnResponse,
} from '../../kernel/types.ts';
import { buildChatMessages, wireTools } from '../openrouter/openai/compat.ts';
import { openAiResponse, openAiUsageTokens } from '../openrouter/openai/usage.ts';
import { foldResponse } from '../shared/response-identity.ts';
import { parseSseStream } from '../shared/sse.ts';
import { toolCallEvents } from '../shared/tool-args.ts';
import { networkFetch, tapFetch } from '../shared/upstream-tap.ts';
import { bearerFetch, requireKey } from '../shared/vault.ts';
import type { LocalTransport } from '../types.ts';

interface OpenAiDelta {
  role?: string;
  content?: string | null;
  /** Thinking text: `reasoning_content` on llama.cpp, vLLM and LM Studio, `reasoning` on Ollama. */
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAiChoice {
  index: number;
  delta?: OpenAiDelta;
  finish_reason?: string | null;
}

export type PendingToolCall = { id: string; name: string; args: string };

function normalizeBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end -= 1;
  return baseUrl.slice(0, end);
}

export function resolveBaseUrl(config: LocalTransport): string {
  const baseUrl = config.baseUrl.trim();
  if (!baseUrl) {
    throw new TheoremError('config', 'Local provider requires baseUrl'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return normalizeBaseUrl(baseUrl);
}

function buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.apiId,
    messages: buildChatMessages(req),
    stream: req.stream !== false,
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  };
  if (body.stream) body.stream_options = { include_usage: true };
  if (req.thinking) body.reasoning_effort = req.thinking;
  const tools = wireTools(req.wireTools);
  if (tools) body.tools = tools;
  return body;
}

export function flushPending(pending: Map<number, PendingToolCall>): ProviderEvent[] {
  const events = [...pending.values()].flatMap((tc) => toolCallEvents(tc, tc.args));
  pending.clear();
  return events;
}

/** A local server takes no key unless the model names a slot; then the key goes as a bearer token. */
function localFetch(
  req: ProviderCompleteRequest,
  config: LocalTransport,
): {
  send: typeof fetch;
  headers: Record<string, string>;
} {
  const fetchFn = networkFetch(config.fetch ?? globalThis.fetch);
  if (!req.keySlot) return { send: tapFetch(req.tapUpstream, fetchFn), headers: {} };
  const key = requireKey(config.vault, req.keySlot);
  return {
    send: bearerFetch(req, fetchFn, config.vault, key),
    headers: { Authorization: `Bearer ${key}` },
  };
}

async function* streamComplete(
  baseUrl: string,
  req: ProviderCompleteRequest,
  config: LocalTransport,
): AsyncGenerator<ProviderEvent> {
  const { send, headers } = localFetch(req, config);
  const res = await send(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(buildBody(req)),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    yield toErrorEvent(
      new TheoremError(kindOfHttpStatus(res.status), `LLM HTTP ${res.status}: ${text}`),
    );
    return;
  }
  if (req.stream === false) {
    yield* bufferedOpenAiBody(await res.json(), req);
    return;
  }
  if (!res.body) {
    yield toErrorEvent(new TheoremError('bad_response', 'empty response body'));
    return;
  }
  yield* streamOpenAiBody(res.body, req);
}

/** The thinking text of one delta or message; none when the profile turned summaries off. */
function* thoughtEvents(
  delta: OpenAiDelta | undefined,
  req: ProviderCompleteRequest,
): Generator<ProviderEvent> {
  if (req.summaries === 'none') return;
  const text = delta?.reasoning_content || delta?.reasoning;
  if (text) yield { type: 'thought', text };
}

function* bufferedOpenAiBody(
  raw: Record<string, unknown>,
  req: ProviderCompleteRequest,
): Generator<ProviderEvent> {
  req.tapUpstream?.(raw);
  const identity = foldResponse(undefined, openAiResponse(raw));
  if (identity.event) yield identity.event;
  const tokens = openAiUsageTokens(raw.usage);
  if (tokens) yield { type: 'tokens', tokens };
  const choice = Array.isArray(raw.choices) ? asRecord(raw.choices[0]) : undefined;
  const message = asRecord(choice?.message) as OpenAiDelta | undefined;
  yield* thoughtEvents(message, req);
  if (message?.content) yield { type: 'text', text: message.content };
  for (const [index, call] of (message?.tool_calls ?? []).entries()) {
    yield* toolCallEvents(
      { id: call.id ?? `call_${index}`, name: call.function?.name ?? '' },
      call.function?.arguments ?? '',
    );
  }
  const finish = choice?.finish_reason;
  yield {
    type: 'done',
    stop: turnStopFromOpenAiFinishReason(typeof finish === 'string' ? finish : null),
  };
}

async function* streamOpenAiBody(
  body: ReadableStream<Uint8Array>,
  req: ProviderCompleteRequest,
): AsyncGenerator<ProviderEvent> {
  const pending = new Map<number, PendingToolCall>();
  let finishReason: string | null | undefined;
  let response: TurnResponse | undefined;
  for await (const raw of parseSseStream(body)) {
    req.tapUpstream?.(raw);
    const identity = foldResponse(response, openAiResponse(raw));
    response = identity.known;
    if (identity.event) yield identity.event;
    const tokens = openAiUsageTokens(raw.usage);
    if (tokens) yield { type: 'tokens', tokens };
    const choice = firstOpenAiChoice(raw);
    if (!choice) continue;
    yield* thoughtEvents(choice.delta, req);
    yield* eventsFromChoiceDelta(choice.delta, pending);
    if (choice.finish_reason != null) {
      finishReason = choice.finish_reason;
      for (const event of flushPending(pending)) yield event;
    }
  }
  for (const event of flushPending(pending)) yield event;
  yield {
    type: 'done',
    stop: turnStopFromOpenAiFinishReason(finishReason),
  };
}

function firstOpenAiChoice(raw: Record<string, unknown>): OpenAiChoice | undefined {
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) return undefined;
  const choice = raw.choices[0];
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return undefined;
  const row = choice as Record<string, unknown>;
  const deltaRaw = row.delta;
  const delta =
    deltaRaw && typeof deltaRaw === 'object' && !Array.isArray(deltaRaw)
      ? (deltaRaw as OpenAiDelta)
      : undefined;
  return {
    index: typeof row.index === 'number' ? row.index : 0,
    delta,
    finish_reason:
      typeof row.finish_reason === 'string' || row.finish_reason === null
        ? (row.finish_reason as string | null)
        : undefined,
  };
}

function* eventsFromChoiceDelta(
  delta: OpenAiDelta | undefined,
  pending: Map<number, PendingToolCall>,
): Generator<ProviderEvent> {
  if (!delta) return;
  if (delta.content) yield { type: 'text', text: delta.content };
  accumulateToolCalls(delta.tool_calls, pending);
}

function accumulateToolCalls(
  toolCalls: OpenAiDelta['tool_calls'],
  pending: Map<number, PendingToolCall>,
): void {
  if (!toolCalls) return;
  for (const tc of toolCalls) {
    const existing = pending.get(tc.index);
    if (existing) {
      existing.args += tc.function?.arguments ?? '';
      continue;
    }
    pending.set(tc.index, {
      id: tc.id ?? `call_${tc.index}`,
      name: tc.function?.name ?? '',
      args: tc.function?.arguments ?? '',
    });
  }
}

/** Creates a provider for a local OpenAI-compatible server, streaming chat completions from its `/v1/chat/completions`; a failure other than an abort is returned as an error event. */
function createLocalProvider(config: LocalTransport): ModelProvider {
  const baseUrl = resolveBaseUrl(config);
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<ProviderEvent> {
      try {
        yield* streamComplete(baseUrl, req, config);
      } catch (err) {
        if (isAbortError(err)) throw err;
        yield toErrorEvent(err);
      }
    },
  };
}

export { buildChatMessages as historyToWire, createLocalProvider, wireTools as toolsToWire };
