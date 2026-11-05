import { z } from 'zod';
import { asRecord } from '../../kernel/engine/record.ts';
import { type JsonObject, jsonObjectSchema } from '../../kernel/json.ts';
import { extendProtocol, type Protocol, type ProtocolEvent } from '../../kernel/protocols/mod.ts';
import { CACHE_MODES, CACHE_TTLS } from '../../kernel/schema.ts';
import type { CacheSpec, Source, TurnHistoryMessage } from '../../kernel/types.ts';
import { openAi } from '../open-ai/protocol.ts';
import { collectReasoning } from './openai/reasoning-state.ts';

// labels-exempt: builder field description, read by the studio and docs
const cache: z.ZodType<CacheSpec> = z
  .strictObject({
    mode: z
      .enum(CACHE_MODES)
      .describe(
        'What is cached: the whole request (`automatic`) or the system instruction only (`system`).',
      ),
    ttl: z
      .enum(CACHE_TTLS)
      .optional()
      .describe('How long the cache is kept. Absent: the upstream default.'),
  })
  .describe('Prompt caching, for models that support it.');

// labels-exempt: builder field description, read by the studio and docs
const routing: z.ZodType<OpenRouterRouting> = z
  .strictObject({
    only: z
      .array(z.string())
      .optional()
      .describe('Upstream endpoints to allow, by slug, such as `gmicloud/fp8`.'),
    order: z.array(z.string()).optional().describe('Upstream endpoints to try first, in order.'),
    ignore: z.array(z.string()).optional().describe('Upstream endpoints to skip.'),
    allow_fallbacks: z
      .boolean()
      .optional()
      .describe('Whether another upstream may answer when the listed ones cannot.'),
    require_parameters: z
      .boolean()
      .optional()
      .describe('Whether every upstream must support every supplied parameter. Unset: on.'),
    data_collection: z
      .enum(['allow', 'deny'])
      .optional()
      .describe('Whether an upstream that may store and train on data can answer.'),
    zdr: z.boolean().optional().describe('Use only endpoints with zero data retention.'),
    enforce_distillable_text: z
      .boolean()
      .optional()
      .describe('Use only models whose authors allow text distillation.'),
    quantizations: z
      .array(z.string())
      .optional()
      .describe('Quantization levels to allow, such as `fp8`.'),
    sort: z
      .union([z.string(), z.strictObject({ by: z.string(), partition: z.string().optional() })])
      .optional()
      .describe('What to order upstreams by: `price`, `throughput` or `latency`.'),
    preferred_min_throughput: z
      .union([z.number(), jsonObjectSchema])
      .optional()
      .describe('Tokens per second below which an upstream is tried later.'),
    preferred_max_latency: z
      .union([z.number(), jsonObjectSchema])
      .optional()
      .describe('Seconds above which an upstream is tried later.'),
    max_price: z
      .strictObject({
        prompt: z.number().optional().describe('The most to pay per million input tokens.'),
        completion: z.number().optional().describe('The most to pay per million output tokens.'),
        request: z.number().optional().describe('The most to pay per request.'),
        image: z.number().optional().describe('The most to pay per image.'),
      })
      .optional()
      .describe('The prices above which an upstream is refused.'),
  })
  .describe('Which upstreams OpenRouter may route to. Absent: its own choice.');

/** What OpenRouter's reasoning comes back as, to be sent back word for word. */
const reasoning = z.strictObject({
  details: z.array(jsonObjectSchema),
  content: z.string().optional(),
});

function cacheControl(spec: CacheSpec): JsonObject {
  return spec.ttl ? { type: 'ephemeral', ttl: spec.ttl } : { type: 'ephemeral' };
}

function callIds(message: unknown): string[] {
  const calls = asRecord(message)?.tool_calls;
  return Array.isArray(calls) ? calls.map((call) => String(asRecord(call)?.id)) : [];
}

/** Puts the reasoning OpenRouter wrote back on the assistant message it came with, matched by its calls. */
function replay(messages: JsonObject[], history: readonly TurnHistoryMessage[]): void {
  for (const message of messages) {
    const ids = callIds(message);
    if (message.role !== 'assistant' || !ids.length) continue;
    const source = history.find(
      (item) =>
        item.role === 'assistant' &&
        JSON.stringify((item.tool_calls ?? []).map((call) => call.id)) === JSON.stringify(ids),
    );
    const data = (source?.reasoning ?? [])
      .map((item) => reasoning.safeParse(item.data))
      .find((parsed) => parsed.success);
    if (!data?.success) continue;
    message.reasoning_details = data.data.details;
    if (data.data.content) message.reasoning = data.data.content;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/** Where OpenRouter puts plain citation lists: the row, its metadata, and each choice. */
function citedUris(row: JsonObject): string[] {
  const meta = (record: Record<string, unknown> | undefined) => [
    record?.citations,
    asRecord(record?.providerMetadata)?.citations,
    asRecord(record?.provider_metadata)?.citations,
  ];
  const openrouter = asRecord(row.openrouter);
  const choices = Array.isArray(row.choices) ? row.choices.map(asRecord) : [];
  return [
    ...meta(row),
    ...meta(openrouter),
    ...meta(asRecord(openrouter?.providerMetadata)),
    ...meta(asRecord(openrouter?.provider_metadata)),
    ...choices.flatMap((choice) => [
      ...meta(asRecord(choice?.message)),
      ...meta(asRecord(choice?.delta)),
    ]),
  ].flatMap(strings);
}

/** Annotations other than URL citations (which the base reads), from the row and its choices. */
function otherAnnotations(row: JsonObject): unknown[] {
  const choices = Array.isArray(row.choices) ? row.choices.map(asRecord) : [];
  const lists = [
    row.annotations,
    asRecord(row.openrouter)?.annotations,
    ...choices.flatMap((choice) => [
      asRecord(choice?.message)?.annotations,
      asRecord(choice?.delta)?.annotations,
    ]),
  ];
  return lists
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((item) => asRecord(item)?.type !== 'url_citation');
}

function thinking(row: JsonObject): string {
  const choices = Array.isArray(row.choices) ? row.choices : [];
  return choices
    .map((choice) => asRecord(asRecord(choice)?.delta)?.thinking)
    .filter((text) => typeof text === 'string')
    .join('');
}

/** What an `openRouterOpenAi` binding sets in `options`. */
export interface OpenRouterOptions {
  cache?: CacheSpec;
  provider?: OpenRouterRouting;
}

/** OpenRouter's own `provider` request field, under its own names. */
export interface OpenRouterRouting {
  only?: string[];
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  quantizations?: string[];
  sort?: string | { by: string; partition?: string };
  preferred_min_throughput?: number | JsonObject;
  preferred_max_latency?: number | JsonObject;
  max_price?: { prompt?: number; completion?: number; request?: number; image?: number };
}

/** Chat Completions with OpenRouter's caching, routing, web search, citations, and reasoning. */
export const openRouterOpenAi: Protocol<OpenRouterOptions> = extendProtocol(openAi, {
  id: 'openRouterOpenAi',
  name: 'OpenRouter Chat Completions',
  description:
    "Chat Completions with OpenRouter's caching, routing, web search, citations and reasoning.", // labels-exempt: builder field description, read by the studio and docs
  options: z.strictObject({ cache: cache.optional(), provider: routing.optional() }),
  reasoning,
  body(body, at) {
    // why: its fields are Chat Completions ones; a speech request goes as openAi sends it.
    if (at.profileType !== 'text') return { body };
    const out = {
      ...body,
      provider: { require_parameters: true, ...at.options.provider },
    } as JsonObject;
    if (out.reasoning_effort !== undefined) {
      out.reasoning = { effort: out.reasoning_effort };
      delete out.reasoning_effort;
    }
    const messages = Array.isArray(out.messages) ? (out.messages as JsonObject[]) : [];
    const spec = at.options.cache;
    if (spec?.mode === 'automatic') out.cache_control = cacheControl(spec);
    if (spec?.mode === 'system' && messages[0]?.role === 'system')
      messages[0] = {
        ...messages[0],
        content: [
          { type: 'text', text: messages[0].content ?? '', cache_control: cacheControl(spec) },
        ],
      };
    replay(messages, at.request?.history ?? []);
    if (at.request?.sessionId) out.session_id = at.request.sessionId;
    const web = at.builtInTools.includes('webSearch');
    if (web) out.web_search_options = {};
    return { body: { ...out, messages }, wroteTools: web ? ['webSearch'] : [] };
  },
  read(at) {
    const details = new Map<string, JsonObject>();
    const cited = new Set<string>();
    const reported = new Set<string>();
    let content = '';
    return {
      row(row) {
        content += collectReasoning(row, details);
        const events: ProtocolEvent[] = [];
        const thought = thinking(row);
        if (thought && at.request?.summaries !== 'none')
          events.push({ type: 'thought', text: thought });
        const sources: Source[] = citedUris(row)
          .filter((uri) => !cited.has(uri) && cited.add(uri))
          .map((uri) => ({ title: uri, uri, type: 'web' }));
        if (sources.length) events.push({ type: 'citation', sources });
        const annotations = otherAnnotations(row).filter((item) => {
          const key = JSON.stringify(item);
          return !reported.has(key) && reported.add(key);
        });
        if (annotations.length)
          events.push({
            type: 'evidence',
            evidence: {
              provider: 'openrouter',
              kind: 'provider_step',
              step: 'annotations',
              raw: { annotations },
            },
          } as ProtocolEvent);
        return { events };
      },
      finish() {
        if (!details.size && !content) return {};
        const data = { details: [...details.values()], ...(content ? { content } : {}) };
        return { events: [{ type: 'reasoning', data }] };
      },
    };
  },
});
