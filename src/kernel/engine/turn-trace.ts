/**
 * The `chat` / `generate_content` span of one model call, and its HTTP tries.
 *
 * The runner opens one per provider stream. It records:
 *
 * - what the model read: system instructions, tool definitions, and every
 *   input message in kernel order (a continuation includes the stored
 *   interaction it extends; `theorem.input.sent_from` marks where the wire
 *   payload starts);
 * - what the model produced, from the provider's own events before any
 *   guardrail touched them;
 * - one `POST` child span per HTTP try, built from the adapter's tap rows,
 *   with the wire body as `theorem.wire.request`, and every provider data row
 *   as `theorem.upstream.row` at its arrival time;
 * - the call's usage, response identity and stop.
 *
 * Request attributes (`gen_ai.request.*`) are what Theorem asked the adapter
 * to send; the wire body on each `POST` is what was sent.
 *
 * @module
 */

import type { GuardrailEvent } from '../../guardrails/types.ts';
import {
  type SpanHandle,
  type SpanLinkInput,
  type SpanOptions,
  type TraceAttributes,
  type TraceAttributeValue,
  type TraceSpanStatus,
  traceBytes,
  traceContent,
  traceJson,
} from '../../observability/trace-span.ts';
import { historyMessageParts } from '../interaction-parts.ts';
import type {
  InteractionPart,
  ModelBinding,
  ProviderCompleteRequest,
  ProviderTransport,
  TurnEvent,
  TurnHistoryMessage,
  TurnInput,
  TurnRequest,
  TurnResponse,
  TurnStop,
  TurnTokens,
  TurnTraceLink,
} from '../types.ts';
import { findLast } from '../util/find-last.ts';
import type { CallUsage } from './runner/usage.ts';
import { sumTokens } from './usage.ts';

type TraceMessage = { [key: string]: TraceAttributeValue };
type TracePart = { [key: string]: TraceAttributeValue };

const MS_PER_S = 1000;
const HTTP_ERROR = 400;
const HTTP_ROWS = new Set(['http_request', 'http_response', 'http_error_body', 'http_throw']);
/** Modalities semconv names under `gen_ai.usage.*`; others go under `theorem.usage.*`. */
const SEMCONV_MODALITIES = new Set(['text', 'image', 'audio']);
/** Stop kinds with a semconv `finish_reason` member; others keep the kernel's name. */
const FINISH_REASON: Partial<Record<TurnStop['kind'], string>> = {
  completed: 'stop',
  length: 'length',
  tool: 'tool_call',
  filtered: 'content_filter',
  provider_error: 'error',
};

// ── messages ────────────────────────────────────────

function mediaModality(mimeType: string): string {
  const [kind] = mimeType.split('/');
  return kind === 'application' || kind === 'text' || !kind ? 'document' : kind;
}

function tracePart(part: InteractionPart): TracePart {
  if (part.type === 'text') {
    return { type: 'text', ...traceContent(part.text) };
  }
  if ('uri' in part) {
    return { type: 'uri', modality: part.type, mime_type: part.mimeType, uri: part.uri };
  }
  return { type: 'blob', modality: part.type, mime_type: part.mimeType, ...traceBytes(part.data) };
}

/** One kernel history message as a semconv chat message. */
function traceMessage(msg: TurnHistoryMessage): TraceMessage {
  const media = historyMessageParts(msg).map(tracePart);
  if (msg.role === 'tool') {
    // The tool's text is its response; media it returned follows as parts.
    const response: TracePart = {
      type: 'tool_call_response',
      ...(msg.tool_call_id ? { id: msg.tool_call_id } : {}),
      response: traceContent(msg.content ?? ''),
    };
    const extra = (msg.parts ?? []).map(tracePart);
    return { role: 'tool', parts: [response, ...extra] };
  }
  const calls = (msg.tool_calls ?? []).map(
    (call): TracePart => ({
      type: 'tool_call',
      id: call.id,
      name: call.function.name,
      arguments: traceContent(call.function.arguments),
    }),
  );
  return { role: msg.role, parts: [...media, ...calls] };
}

/** Messages the model read on a call, and what it wrote back. */
interface CallMessages {
  input: TraceMessage[];
  output?: TraceMessage;
}

/** Keyed by the call's usage record, which continuations already chain. */
const callMessages = new WeakMap<CallUsage, CallMessages>();

/** Everything the model reads on `usage`'s call, and where the wire payload starts. */
function inputMessages(usage: CallUsage): { input: TraceMessage[]; sentFrom?: number } {
  const { conversation } = usage;
  if ('previous' in conversation) {
    const previous = callMessages.get(conversation.previous);
    const stored = [...(previous?.input ?? []), ...(previous?.output ? [previous.output] : [])];
    return {
      input: [...stored, ...conversation.continuation.map(traceMessage)],
      sentFrom: stored.length,
    };
  }
  const opening: TraceMessage[] =
    conversation.input.length > 0
      ? [{ role: 'user', parts: conversation.input.map(tracePart) }]
      : [];
  return { input: [...conversation.history.map(traceMessage), ...opening] };
}

// ── output ──────────────────────────────────────────

/** Live transcription evidence kinds. Their text is labelled, never taken for the model's. */
const TRANSCRIPTION_KINDS = new Set(['input_transcription', 'output_transcription']);

/** Output parts folded from provider events: adjacent deltas of one kind merge. */
class OutputFold {
  readonly parts: TracePart[] = [];
  private open?: { key: string; text: string; part: TracePart };

  add(event: TurnEvent, nowUnixNano: string): void {
    switch (event.type) {
      case 'text':
        this.appendText('text', event.text ?? '');
        return;
      case 'thought':
        this.appendText('reasoning', event.text ?? '');
        return;
      case 'tool':
        if (event.tool) this.push(toolCallPart(event.tool));
        return;
      case 'media':
        if (event.media) this.push(mediaPart(event.media));
        return;
      case 'evidence': {
        const kind = event.evidence?.kind;
        if (kind && TRANSCRIPTION_KINDS.has(kind)) {
          this.appendText('text', event.text ?? '', kind, event.evidence?.interim);
          return;
        }
        const part = event.evidence ? serverToolPart(event.evidence, nowUnixNano) : undefined;
        if (part) this.push(part);
        return;
      }
      default:
        return;
    }
  }

  private appendText(
    type: 'text' | 'reasoning',
    text: string,
    /** A transcription kind, when the text is the provider's transcript. */
    source?: string,
    interim?: boolean,
  ): void {
    if (!text) return;
    const key = `${type}:${source ?? ''}:${interim ? 'interim' : ''}`;
    if (this.open?.key === key) {
      this.open.text += text;
      Object.assign(this.open.part, traceContent(this.open.text));
      return;
    }
    const part: TracePart = {
      type,
      ...traceContent(text),
      ...optional('theorem.source', source),
      ...(interim ? { 'theorem.interim': true } : {}),
    };
    this.parts.push(part);
    this.open = { key, text, part };
  }

  private push(part: TracePart): void {
    this.parts.push(part);
    this.open = undefined;
  }
}

/**
 * A tool call's arguments as the model sent them. Malformed arguments keep the
 * provider's raw text; parsed ones are the same JSON the kernel sends back in
 * history, so both hash alike.
 */
function toolArgumentsText(
  tool: Pick<NonNullable<TurnEvent['tool']>, 'arguments' | 'failure'>,
): string {
  const details = tool.failure?.details;
  const raw =
    details && typeof details === 'object' && 'raw' in details && typeof details.raw === 'string'
      ? details.raw
      : undefined;
  return raw ?? JSON.stringify(tool.arguments ?? {});
}

function toolCallPart(tool: NonNullable<TurnEvent['tool']>): TracePart {
  return {
    type: 'tool_call',
    ...(tool.id ? { id: tool.id } : {}),
    name: tool.name,
    arguments: traceContent(toolArgumentsText(tool)),
  };
}

function mediaPart(media: { mimeType: string; data: string }): TracePart {
  return {
    type: 'blob',
    modality: mediaModality(media.mimeType),
    mime_type: media.mimeType,
    ...traceBytes(media.data),
  };
}

const CALL_SUFFIX = '_call';
const RESULT_SUFFIX = '_result';

/**
 * A provider-run tool step as a semconv server tool part. The kernel sees a
 * step only once it is whole, so its arrival is `theorem.observed_end`; the
 * row events hold every earlier row's arrival.
 */
function serverToolPart(
  evidence: NonNullable<TurnEvent['evidence']>,
  nowUnixNano: string,
): TracePart | undefined {
  const kind = evidence.kind ?? '';
  const observed = {
    'theorem.observed_end': nowUnixNano,
    ...(evidence.partial ? { 'theorem.partial': true } : {}),
  };
  if (kind.endsWith(CALL_SUFFIX)) {
    const name = kind.slice(0, -CALL_SUFFIX.length);
    return {
      type: 'server_tool_call',
      ...(evidence.id ? { id: evidence.id } : {}),
      name,
      server_tool_call: { ...traceJson(evidence.raw ?? {}), type: name },
      ...observed,
    };
  }
  if (kind.endsWith(RESULT_SUFFIX)) {
    const name = kind.slice(0, -RESULT_SUFFIX.length);
    return {
      type: 'server_tool_call_response',
      ...(evidence.callId ? { id: evidence.callId } : {}),
      server_tool_call_response: { ...traceJson(evidence.raw ?? {}), type: name },
      ...observed,
    };
  }
  return undefined;
}

/** Grounding and citations as a `theorem.grounding` event; the raw payload needs `evidenceRaw`. */
function groundingEvent(event: TurnEvent): TraceAttributes | undefined {
  if (event.type === 'grounding' && event.grounding) {
    const { sources, searchHtml, metadata, chunks } = event.grounding;
    return {
      sources: traceJson(sources),
      ...(searchHtml ? { search_html: traceContent(searchHtml) } : {}),
      ...(metadata || chunks ? { raw: traceJson({ metadata, chunks }) } : {}),
    };
  }
  if (
    event.type === 'evidence' &&
    event.evidence &&
    !serverToolKind(event.evidence.kind) &&
    !TRANSCRIPTION_KINDS.has(event.evidence.kind ?? '')
  ) {
    const { provider, sources, citations, annotations, raw } = event.evidence;
    return {
      provider,
      ...(sources ? { sources: traceJson(sources) } : {}),
      ...(citations ? { citations: traceJson(citations) } : {}),
      ...(annotations ? { annotations: traceJson(annotations) } : {}),
      ...(raw ? { raw: traceJson(raw) } : {}),
    };
  }
  return undefined;
}

function serverToolKind(kind: string | undefined): boolean {
  return Boolean(kind && (kind.endsWith(CALL_SUFFIX) || kind.endsWith(RESULT_SUFFIX)));
}

// ── guardrails ──────────────────────────────────────

/**
 * A guardrail decision as `theorem.guardrail` event attributes. The matched
 * substring stays exact (not scrubbed: scrubbing it would erase what it shows);
 * the record drops it unless the profile includes `guardrailMatchPreview`.
 */
function guardrailAttributes(guardrail: GuardrailEvent): TraceAttributes {
  return {
    stage: guardrail.stage,
    trust: guardrail.trust,
    action: guardrail.action,
    hits: guardrail.hits.map((hit) => ({
      rule: hit.rule,
      severity: hit.severity,
      ...(hit.span ? { start: hit.span.start, end: hit.span.end } : {}),
      ...optional('match', hit.match),
    })),
    ...(guardrail.provenance ? { provenance: { ...guardrail.provenance } } : {}),
  };
}

// ── usage ───────────────────────────────────────────

function modalityAttributes(byModality: TurnTokens['byModality']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const side of ['input', 'output'] as const) {
    for (const [modality, count] of Object.entries(byModality?.[side] ?? {})) {
      const family = SEMCONV_MODALITIES.has(modality) ? 'gen_ai' : 'theorem';
      out[`${family}.usage.${modality}.${side}_tokens`] = count;
    }
  }
  return out;
}

/** `{ [key]: value }`, or nothing when the value was not given. */
function optional(key: string, value: TraceAttributeValue | undefined): TraceAttributes {
  return value === undefined ? {} : { [key]: value };
}

/** A call's or an agent's usage as span attributes. Absent fields stay absent. */
function usageAttributes(tokens: TurnTokens): TraceAttributes {
  return {
    'gen_ai.usage.input_tokens': tokens.input,
    'gen_ai.usage.output_tokens': tokens.output,
    ...optional('gen_ai.usage.reasoning.output_tokens', tokens.thinking),
    ...optional('gen_ai.usage.cache_read.input_tokens', tokens.cached),
    ...optional('gen_ai.usage.cache_write.input_tokens', tokens.cacheWrite),
    ...optional('theorem.usage.tool_use.input_tokens', tokens.toolUse),
    ...modalityAttributes(tokens.byModality),
    ...(tokens.grounding
      ? {
          'theorem.usage.grounding': tokens.grounding.map((entry) => ({
            type: entry.type,
            count: entry.count,
            ...optional('search_query_count', entry.searchQueryCount),
          })),
        }
      : {}),
    ...optional('theorem.usage.cost_usd', tokens.cost?.usd),
    ...optional('theorem.usage.upstream_cost_usd', tokens.cost?.upstreamUsd),
    ...(tokens.cost?.partial ? { 'theorem.usage.cost_partial': true } : {}),
    ...(tokens.estimated?.length ? { 'theorem.usage.estimated': [...tokens.estimated] } : {}),
    ...(tokens.unknownMedia ? { 'theorem.usage.unknown_media': { ...tokens.unknownMedia } } : {}),
  };
}

// ── request ─────────────────────────────────────────

function operationName(transport: ProviderTransport): 'chat' | 'generate_content' {
  return transport === 'openAiCompat' ? 'chat' : 'generate_content';
}

/** `gen_ai.provider.name`: semconv's name where one exists; a local server only when declared. */
function providerName(binding: ModelBinding | undefined): string | undefined {
  switch (binding?.provider) {
    case 'google':
      return 'gcp.gemini';
    case 'openrouter':
      return 'openrouter';
    default:
      return binding?.server;
  }
}

function outputType(req: ProviderCompleteRequest): string {
  if (req.structured) return 'json';
  if (req.image) return 'image';
  if (req.speech) return 'speech';
  return 'text';
}

function requestAttributes(
  req: ProviderCompleteRequest,
  binding: ModelBinding | undefined,
  transport: ProviderTransport,
): TraceAttributes {
  const provider = providerName(binding);
  return {
    'gen_ai.operation.name': operationName(transport),
    ...optional('gen_ai.provider.name', provider),
    'gen_ai.request.model': req.apiId,
    'theorem.model.id': req.model,
    ...optional('gen_ai.request.stream', req.stream),
    ...optional('gen_ai.request.temperature', req.temperature),
    ...optional('gen_ai.request.max_tokens', req.maxOutputTokens),
    ...optional('gen_ai.request.reasoning.level', req.thinking),
    ...optional('gen_ai.request.previous_response.id', req.previousInteractionId),
    'gen_ai.system_instructions': [{ type: 'text', ...traceContent(req.system) }],
    ...(req.wireTools?.length
      ? { 'gen_ai.tool.definitions': traceContent(JSON.stringify(req.wireTools)) }
      : {}),
    'gen_ai.output.type': outputType(req),
    ...optional('theorem.key_slot', req.keySlot),
    ...controlAttributes(req),
  };
}

/**
 * Request controls semconv has no names for, as requested. The Maps location
 * builtin's coordinates are left to the wire body (`outboundWire`): they locate
 * the user.
 */
function controlAttributes(req: ProviderCompleteRequest): TraceAttributes {
  const { cache, image, speech, live } = req;
  return {
    'theorem.request.builtins': [...req.builtins],
    ...optional('theorem.request.store', req.store),
    ...optional('theorem.request.summaries', req.summaries),
    ...optional('theorem.request.structured', req.structured ?? undefined),
    ...optional('theorem.request.session_id', req.sessionId),
    ...(cache
      ? { 'theorem.request.cache': { mode: cache.mode, ...optional('ttl', cache.ttl) } }
      : {}),
    ...(image
      ? {
          'theorem.request.image': {
            ...optional('mime_type', image.mimeType),
            ...optional('aspect_ratio', image.aspectRatio),
            ...optional('size', image.size),
            include_text: image.includeText,
          },
        }
      : {}),
    ...(speech
      ? {
          'theorem.request.speech': {
            ...optional('voice', speech.voice),
            ...optional('format', speech.format),
          },
        }
      : {}),
    ...(live ? { 'theorem.request.live': liveAttributes(live, req) } : {}),
  };
}

/** Live session setup as sent. A resumption handle is a credential: only its presence is kept. */
function liveAttributes(
  live: NonNullable<ProviderCompleteRequest['live']>,
  req: ProviderCompleteRequest,
): TraceAttributes {
  const { vad, transcription } = live;
  return {
    ...optional('voice', live.voice),
    ...(vad
      ? {
          vad: {
            ...optional('activity_handling', vad.activityHandling),
            ...optional('start_sensitivity', vad.startSensitivity),
            ...optional('end_sensitivity', vad.endSensitivity),
            ...optional('prefix_padding_ms', vad.prefixPaddingMs),
            ...optional('silence_duration_ms', vad.silenceDurationMs),
          },
        }
      : {}),
    ...optional('session_resumption', live.sessionResumption),
    ...optional('context_compression', live.contextCompression),
    ...optional('proactive_audio', live.proactiveAudio),
    ...(transcription
      ? {
          transcription: {
            ...optional('input', transcription.input),
            ...optional('output', transcription.output),
          },
        }
      : {}),
    resumed: Boolean(req.sessionResumptionHandle),
  };
}

// ── HTTP tries ──────────────────────────────────────

function headerAttributes(prefix: string, headers: unknown): TraceAttributes {
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [`${prefix}.${key}`, [String(value)]]),
  );
}

function urlAttributes(url: unknown): TraceAttributes {
  if (typeof url !== 'string') return {};
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  // The path only: a query can carry credentials.
  return parsed ? { 'server.address': parsed.hostname, 'url.path': parsed.pathname } : {};
}

/** POST spans of one call, opened and closed from the adapter's tap rows. */
class HttpTries {
  private tries = 0;
  private current?: SpanHandle;
  private last?: SpanHandle;
  /** Status of the latest response; `error.type` of a failed call. */
  lastStatus?: number;
  private awaitingFirstChunk = false;

  constructor(
    private readonly call: SpanHandle,
    private readonly streamed: boolean,
  ) {}

  /** Handle one tap row; returns false for a provider data row. */
  row(row: Record<string, unknown>): boolean {
    const type = typeof row.eventType === 'string' ? row.eventType : undefined;
    if (!type || !HTTP_ROWS.has(type)) {
      this.firstChunk();
      return false;
    }
    if (type === 'http_request') this.open(row);
    else if (type === 'http_response') this.response(row);
    else if (type === 'http_error_body') this.errorBody(row);
    else this.thrown(row);
    return true;
  }

  private open(row: Record<string, unknown>): void {
    this.current?.end();
    const backoff = this.last?.msSinceEnd();
    this.current = this.call.child(String(row.method ?? 'GET'), {
      kind: 'CLIENT',
      attributes: {
        'http.request.method': String(row.method ?? 'GET'),
        ...urlAttributes(row.url),
        'http.request.resend_count': this.tries,
        ...(typeof row.keySlot === 'string' ? { 'theorem.key_slot': row.keySlot } : {}),
        ...optional('theorem.retry.backoff_ms', backoff),
        ...headerAttributes('http.request.header', row.headers),
      },
    });
    this.tries += 1;
    if ('body' in row) {
      this.current.event('theorem.wire.request', { body: traceJson(row.body) });
    } else if (typeof row.bodyKind === 'string') {
      this.current.event('theorem.wire.request', { body_kind: row.bodyKind });
    }
    if (typeof row.keySlot === 'string') this.call.set({ 'theorem.key_slot': row.keySlot });
  }

  private response(row: Record<string, unknown>): void {
    const status = typeof row.status === 'number' ? row.status : undefined;
    this.lastStatus = status;
    this.current?.set({
      ...optional('http.response.status_code', status),
      ...headerAttributes('http.response.header', row.headers),
    });
    if (status !== undefined && status >= HTTP_ERROR) {
      this.current?.set({ 'error.type': String(status) });
    } else {
      this.awaitingFirstChunk = this.streamed;
    }
  }

  private errorBody(row: Record<string, unknown>): void {
    this.current?.event('theorem.upstream.row', { row: traceJson(row) });
    this.close({ code: 'ERROR', message: String(this.lastStatus ?? 'error') });
  }

  private thrown(row: Record<string, unknown>): void {
    const name = typeof row.name === 'string' ? row.name : 'Error';
    this.current?.event('exception', {
      'exception.type': name,
      'exception.message': traceContent(String(row.message ?? '')),
    });
    this.current?.set({ 'error.type': name });
    this.close({ code: 'ERROR', message: name });
  }

  private firstChunk(): void {
    if (!(this.awaitingFirstChunk && this.current)) return;
    this.awaitingFirstChunk = false;
    this.call.set({
      'gen_ai.response.time_to_first_chunk': this.current.msSinceStart() / MS_PER_S,
    });
  }

  close(status: Parameters<SpanHandle['end']>[0]): void {
    if (!this.current) return;
    this.current.end(status);
    this.last = this.current;
    this.current = undefined;
  }
}

/**
 * How a try still open at call end (a streamed body) ended: by its HTTP status
 * and whether reading it threw. A provider error inside a 200 body is the
 * call's failure, not the try's.
 */
function httpStatus(
  status: number | undefined,
  cancelled: boolean,
  thrown: unknown,
): Parameters<SpanHandle['end']>[0] {
  if (status !== undefined && status >= HTTP_ERROR) {
    return { code: 'ERROR', message: String(status) };
  }
  if (thrown !== undefined) {
    return { code: 'ERROR', message: errorName(thrown) };
  }
  return cancelled ? { code: 'UNSET' } : { code: 'OK' };
}

/** The name a thrown value is recorded under (`error.type`, `exception.type`). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** A thrown value as a semconv `exception` event. */
function recordException(span: SpanHandle, err: unknown): void {
  span.event('exception', {
    'exception.type': errorName(err),
    'exception.message': traceContent(err instanceof Error ? err.message : String(err)),
  });
}

// ── the call span ───────────────────────────────────

/** How a call ended, as the runner saw it. */
interface CallEnd {
  /** The call's one usage report (estimated sides filled), when there is one. */
  tokens?: TurnTokens;
  /** The stop the runner took from this call. */
  stop?: TurnStop;
  /** Thrown out of the stream (not an abort). */
  thrown?: unknown;
}

/** Recorder for one model call. */
interface CallTrace {
  span: SpanHandle;
  /** Pass as the adapter's `tapUpstream`. */
  tap: (row: Record<string, unknown>) => void;
  /** Every provider event, before guardrails. */
  observe: (event: TurnEvent) => void;
  /** A guardrail decision on this call's output. */
  guardrail: (event: TurnEvent) => void;
  end: (end: CallEnd) => void;
}

/** Stops where the model did not finish its output: no finish reason, status `UNSET`. */
const STOPPED_CALLS = new Set<TurnStop['kind']>(['cancelled', 'interrupted']);

/** How a call ended: its span status, finish reason, and the error type when it failed. */
function callOutcome(
  stop: TurnStop | undefined,
  failed: boolean,
  lastStatus: number | undefined,
): { stopped: boolean; finish?: string; status: TraceSpanStatus; attributes: TraceAttributes } {
  const stopped = stop !== undefined && STOPPED_CALLS.has(stop.kind);
  const finish = stop && !stopped ? (FINISH_REASON[stop.kind] ?? stop.kind) : undefined;
  if (failed) {
    const errorType =
      lastStatus && lastStatus >= HTTP_ERROR ? String(lastStatus) : 'provider_error';
    return {
      stopped,
      finish,
      status: { code: 'ERROR', message: 'provider_error' },
      attributes: { 'error.type': errorType },
    };
  }
  return { stopped, finish, status: { code: stopped ? 'UNSET' : 'OK' }, attributes: {} };
}

/** What the provider said about the response it produced. */
function responseAttributes(
  response: TurnResponse | undefined,
  native: string | undefined,
  transport: ProviderTransport,
): TraceAttributes {
  const reported: TraceAttributes = !native
    ? {}
    : transport === 'openAiCompat'
      ? { 'gen_ai.response.finish_reasons': [native] }
      : { 'gen_ai.response.status': native };
  return {
    ...optional('gen_ai.response.id', response?.id || undefined),
    ...optional('gen_ai.response.model', response?.model || undefined),
    ...reported,
  };
}

/**
 * Open the span for one model call; `open` places it (a child of the turn's
 * root, or the root of a Live response's own record). `usage` is the call's
 * usage record; its conversation is what the model reads. It is read again at
 * the end, so input sent while the call ran (a Live tool result) is included.
 */
function startCallTrace(
  open: (name: string, options: SpanOptions) => SpanHandle,
  args: {
    req: ProviderCompleteRequest;
    usage: CallUsage;
    binding: ModelBinding | undefined;
    transport: ProviderTransport;
    step: number;
    /** The runner's validation attempt; Live has none. */
    attempt?: number;
  },
): CallTrace {
  const { req, usage, transport } = args;
  const opening = inputMessages(usage);
  const span = open(`${operationName(transport)} ${req.apiId}`, {
    kind: 'CLIENT',
    attributes: {
      ...requestAttributes(req, args.binding, transport),
      'gen_ai.input.messages': opening.input,
      ...optional('theorem.input.sent_from', opening.sentFrom),
      'theorem.step': args.step,
      ...optional('theorem.attempt', args.attempt),
    },
  });
  const http = new HttpTries(span, req.stream !== false);
  const output = new OutputFold();
  const heard = new OutputFold();
  const errors: TurnEvent[] = [];
  let response: TurnResponse | undefined;
  let native: string | undefined;

  return {
    span,
    tap: (row) => {
      if (!http.row(row)) span.event('theorem.upstream.row', { row: traceJson(row) });
    },
    observe: (event) => {
      if (event.evidence?.kind === 'input_transcription') {
        // What the provider heard in the input: labelled, beside what the model read.
        heard.add(event, span.nowUnixNano());
        return;
      }
      output.add(event, span.nowUnixNano());
      const grounding = groundingEvent(event);
      if (grounding) span.event('theorem.grounding', grounding);
      if (event.type === 'error') errors.push(event);
      if (event.type === 'response') response = event.response ?? response;
      if (event.type === 'done') native = event.stop?.native ?? native;
    },
    guardrail: (event) => {
      if (event.guardrail) span.event('theorem.guardrail', guardrailAttributes(event.guardrail));
    },
    end: (end) => {
      for (const error of errors) {
        span.event('exception', {
          'exception.type': 'provider_error',
          'exception.message': traceContent(error.errorInternal ?? error.error ?? ''),
        });
      }
      if (end.thrown !== undefined) recordException(span, end.thrown);
      const failed = errors.length > 0 || end.thrown !== undefined;
      const outcome = callOutcome(end.stop, failed, http.lastStatus);
      const outputMessage: TraceMessage = {
        role: 'assistant',
        parts: output.parts,
        ...optional('finish_reason', outcome.finish),
      };
      const { input } = inputMessages(usage);
      // A continuation replays what the model read, not the provider's transcript of it.
      callMessages.set(usage, { input, output: outputMessage });
      const transcript: TraceMessage[] =
        heard.parts.length > 0 ? [{ role: 'user', parts: heard.parts }] : [];
      http.close(httpStatus(http.lastStatus, outcome.stopped, end.thrown));
      span.set({
        'gen_ai.input.messages': [...input, ...transcript],
        'gen_ai.output.messages': [outputMessage],
        ...(end.tokens ? usageAttributes(end.tokens) : {}),
        ...responseAttributes(response, outcome.stopped ? undefined : native, transport),
        ...optional('theorem.stop.kind', end.stop?.kind),
        ...outcome.attributes,
      });
      span.end(outcome.status);
    },
  };
}

// ── the turn span ───────────────────────────────────

/** The host's new input as one user message, exactly as it arrived (before ingress). */
function turnInputMessages(input: TurnInput | undefined): TraceMessage[] {
  const media = [...(input?.attachments ?? []), ...(input?.voice ?? [])].map(
    (blob): TracePart =>
      'uri' in blob
        ? {
            type: 'uri',
            modality: mediaModality(blob.mimeType),
            mime_type: blob.mimeType,
            uri: blob.uri,
          }
        : {
            type: 'blob',
            modality: mediaModality(blob.mimeType),
            mime_type: blob.mimeType,
            ...traceBytes(blob.data),
          },
  );
  const parts = [...(input?.text ? [{ type: 'text', ...traceContent(input.text) }] : []), ...media];
  return parts.length > 0 ? [{ role: 'user', parts }] : [];
}

/** Earlier traces a root follows from, as span links. */
function traceLinks(links: readonly TurnTraceLink[] | undefined): SpanLinkInput[] {
  return (links ?? []).map((link) => ({
    traceparent: link.traceparent,
    attributes: {
      'theorem.link.kind': link.kind,
      ...optional('theorem.stop.kind', link.stop),
    },
  }));
}

/** Options for a turn's `invoke_agent` span, from the host request. */
function turnSpanOptions(req: TurnRequest): SpanOptions {
  return {
    kind: 'INTERNAL',
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': req.profile,
      ...optional('gen_ai.conversation.id', req.conversationId),
      'gen_ai.input.messages': turnInputMessages(req.input),
      ...optional('theorem.request.effort', req.effort),
      ...optional('theorem.request.model_select', req.model),
      ...optional('theorem.project.id', req.projectId),
    },
    links: traceLinks(req.links),
  };
}

/** Stops where the turn failed; the rest either finished or were stopped on purpose. */
const FAILED_STOPS = new Set<TurnStop['kind']>(['provider_error', 'stream_incomplete']);
const FINISHED_STOPS = new Set<TurnStop['kind']>(['completed', 'length', 'generation_complete']);

/** How a turn ended, as its runner saw it. */
interface TurnEnd {
  /** Every event the host received. */
  seen: readonly TurnEvent[];
  /** Validation / egress attempts that made a model call. */
  attempts: number;
  /** Model calls made. */
  calls: number;
  compacted: boolean;
  /** Thrown out of the turn (not an abort). */
  thrown?: unknown;
}

/**
 * Close a turn's `invoke_agent` span. Usage is the sum of this turn's own
 * calls; a nested turn (compaction) carries its own.
 */
function endTurnSpan(root: SpanHandle, end: TurnEnd): void {
  const tokens = sumTokens(
    end.seen.flatMap((ev) => (ev.type === 'tokens' && ev.tokens ? [ev.tokens] : [])),
  );
  const done = findLast(end.seen, (ev) => ev.type === 'done');
  const stop = done?.stop?.kind;
  const publicError = findLast(end.seen, (ev) => ev.type === 'error')?.error;
  const threw = end.thrown !== undefined;
  if (threw) recordException(root, end.thrown);
  const failed = threw || (stop !== undefined && FAILED_STOPS.has(stop));
  root.set({
    ...(tokens ? usageAttributes(tokens) : {}),
    ...(stop ? { 'theorem.stop.kind': stop } : {}),
    'theorem.attempts': end.attempts,
    'theorem.steps': end.calls,
    ...(end.compacted ? { 'gen_ai.conversation.compacted': true } : {}),
    ...(failed && publicError ? { 'theorem.error.public': traceContent(publicError) } : {}),
    ...(threw ? { 'error.type': errorName(end.thrown) } : {}),
    ...(failed && !threw && stop ? { 'error.type': stop } : {}),
  });
  if (failed) {
    root.end({ code: 'ERROR', ...(stop && !threw ? { message: stop } : {}) });
  } else {
    root.end(stop && !FINISHED_STOPS.has(stop) ? { code: 'UNSET' } : { code: 'OK' });
  }
}

export type { CallEnd, CallTrace, TracePart, TurnEnd };
export {
  endTurnSpan,
  errorName,
  guardrailAttributes,
  optional,
  recordException,
  startCallTrace,
  toolArgumentsText,
  traceLinks,
  tracePart,
  turnSpanOptions,
  urlAttributes,
  usageAttributes,
};
