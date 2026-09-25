/**
 * Local provider adapter for OpenAI-compatible endpoints (Ollama, llama.cpp,
 * vLLM, LM Studio, etc.).
 *
 * Streams SSE from `/v1/chat/completions`, accumulates tool calls, and yields
 * normalized `TurnEvent` objects. No external SDK dependency — raw fetch + SSE.
 *
 * Wire-format message building delegates to the shared `openai/compat` module.
 * SSE parsing delegates to the shared `parseSseStream` from `sse.ts`.
 *
 * Hosts pass `baseUrl` explicitly. THEOREM does not read `OLLAMA_HOST` or other
 * environment variables (see docs/contracts/providers.md).
 *
 * @module
 */

import {
  isAbortError,
  kindOfHttpStatus,
  TheoremError,
  toErrorEvent,
} from '../../guardrails/error.ts';
import { turnStopFromOpenAiFinishReason } from '../../kernel/stop.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnResponse,
} from '../../kernel/types.ts';
import { buildChatMessages, wireTools } from '../openrouter/openai/compat.ts';
import { openAiResponse, openAiUsageTokens } from '../openrouter/openai/usage.ts';
import { foldResponse } from '../shared/response-identity.ts';
import { parseSseStream } from '../shared/sse.ts';
import { parseToolArgumentsObject } from '../shared/tool-args.ts';
import { networkFetch, tapFetch } from '../shared/upstream-tap.ts';
import type { LocalProviderConfig } from '../types.ts';

/** Default OpenAI-compat base when the host omits `baseUrl` (Ollama's default port). */
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434';

// ── wire types ──────────────────────────────────────

interface OpenAiDelta {
  role?: string;
  content?: string | null;
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

// ── request mapping ─────────────────────────────────

function normalizeBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end -= 1;
  return baseUrl.slice(0, end);
}

export function resolveBaseUrl(config?: LocalProviderConfig): string {
  return normalizeBaseUrl(config?.baseUrl?.trim() || DEFAULT_LOCAL_BASE_URL);
}

function buildBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.apiId,
    messages: buildChatMessages(req),
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  };
  const tools = wireTools(req.wireTools);
  if (tools) body.tools = tools;
  return body;
}

// ── stream → TurnEvent ──────────────────────────────

export function flushPending(pending: Map<number, PendingToolCall>): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const [, tc] of pending) {
    const parsed = parseToolArgumentsObject(tc.args);
    if (!parsed.ok) {
      events.push({
        type: 'tool',
        tool: {
          name: tc.name,
          arguments: {},
          id: tc.id,
          phase: 'error',
          failure: {
            code: 'malformed_arguments',
            kind: 'bad_response',
            message: parsed.error,
            details: { raw: parsed.raw },
          },
        },
      });
      continue;
    }
    events.push({
      type: 'tool',
      tool: { name: tc.name, arguments: parsed.value, id: tc.id },
    });
  }
  pending.clear();
  return events;
}

async function* streamComplete(
  baseUrl: string,
  req: ProviderCompleteRequest,
  fetchFn: typeof globalThis.fetch,
): AsyncGenerator<TurnEvent> {
  const res = await tapFetch(req.tapUpstream, networkFetch(fetchFn))(
    `${baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(req)),
      signal: req.signal,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    yield toErrorEvent(
      new TheoremError(kindOfHttpStatus(res.status), `LLM HTTP ${res.status}: ${text}`),
    );
    return;
  }
  if (!res.body) {
    yield toErrorEvent(new TheoremError('bad_response', 'empty response body'));
    return;
  }
  yield* streamOpenAiBody(res.body, req.tapUpstream);
}

async function* streamOpenAiBody(
  body: ReadableStream<Uint8Array>,
  tap: ProviderCompleteRequest['tapUpstream'],
): AsyncGenerator<TurnEvent> {
  const pending = new Map<number, PendingToolCall>();
  let finishReason: string | null | undefined;
  let response: TurnResponse | undefined;
  for await (const raw of parseSseStream(body)) {
    tap?.(raw);
    const identity = foldResponse(response, openAiResponse(raw));
    response = identity.known;
    if (identity.event) yield identity.event;
    const tokens = openAiUsageTokens(raw.usage);
    if (tokens) yield { type: 'tokens', tokens };
    const choice = firstOpenAiChoice(raw);
    if (!choice) continue;
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
): Generator<TurnEvent> {
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

// ── public factory ──────────────────────────────────

/** Create a `ModelProvider` for a local OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio). */
function createLocalProvider(config?: LocalProviderConfig): ModelProvider {
  const baseUrl = resolveBaseUrl(config);
  const fetchFn = config?.fetch ?? globalThis.fetch;
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      try {
        yield* streamComplete(baseUrl, req, fetchFn);
      } catch (err) {
        if (isAbortError(err)) throw err;
        yield toErrorEvent(err);
      }
    },
  };
}

export { buildChatMessages as historyToWire, createLocalProvider, wireTools as toolsToWire };
