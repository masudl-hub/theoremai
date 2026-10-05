import { type ErrorKind, errorKind } from '../../guardrails/error.ts';
import type { GuardrailEvent, GuardrailStage, TrustLevel } from '../../guardrails/types.ts';
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
import type { ToolCallEvent, ToolCallRequest, ToolFailure } from '../tools/types.ts';
import type {
  InteractionPart,
  ModelBinding,
  ProviderCompleteRequest,
  ProviderEvent,
  ProviderEvidence,
  ProviderTransport,
  TurnEvent,
  TurnEventOf,
  TurnHistoryMessage,
  TurnInput,
  TurnRequest,
  TurnResponse,
  TurnStop,
  TurnTokens,
  TurnTraceLink,
} from '../types.ts';
import { findLast } from '../util/find-last.ts';
import { asRecord } from './record.ts';
import type { CallUsage } from './runner/usage.ts';
import { sumEventTokens } from './usage.ts';

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

function traceMessage(msg: TurnHistoryMessage): TraceMessage {
  const media = historyMessageParts(msg).map(tracePart);
  if (msg.role === 'tool') {
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

/** Output parts folded from provider events: adjacent deltas of one kind merge. */
class OutputFold {
  readonly parts: TracePart[] = [];
  private open?: { key: string; text: string; part: TracePart };
  /** Each call's `tool_call` part by `callId`, for the failure that follows a malformed one. */
  private readonly calls = new Map<string, TracePart>();

  add(event: ProviderEvent, nowUnixNano: string): void {
    switch (event.type) {
      case 'text':
        this.appendText('text', event.text);
        return;
      case 'thought':
        this.appendText('reasoning', event.text);
        return;
      case 'tool':
        this.addTool(event.tool);
        return;
      case 'structured':
        this.push({ type: 'structured', content: traceJson(event.structured ?? null) });
        return;
      case 'media':
        this.push(mediaPart(event.media));
        return;
      case 'evidence': {
        const { evidence } = event;
        // why: Live transcription: labelled, never taken for the model's own text.
        if (evidence.kind === 'input_transcription' || evidence.kind === 'output_transcription') {
          this.appendText('text', event.text ?? '', evidence.kind, evidence.interim);
          return;
        }
        const part = serverToolPart(evidence, nowUnixNano);
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

  /**
   * The model's call as a `tool_call` part. A malformed call's failure follows
   * it from the provider; the part then records the text the model sent.
   */
  private addTool(tool: ToolCallEvent): void {
    if (tool.phase === undefined) {
      const part = toolCallPart(tool);
      this.calls.set(tool.callId, part);
      this.push(part);
      return;
    }
    const call = this.calls.get(tool.callId);
    const sent = tool.phase === 'error' ? sentArgumentsText(tool.failure) : undefined;
    if (call && sent !== undefined) Object.assign(call, { arguments: traceContent(sent) });
  }

  private push(part: TracePart): void {
    this.parts.push(part);
    this.open = undefined;
  }
}

interface SentToolCall {
  arguments: Record<string, unknown>;
  failure?: ToolFailure;
}

/** The provider's raw text for arguments that did not parse (`details.raw`). */
function sentArgumentsText(failure: ToolFailure | undefined): string | undefined {
  const raw = asRecord(failure?.details)?.raw;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * A tool call's arguments as the model sent them. Malformed arguments keep the
 * provider's raw text; parsed ones are the same JSON the kernel sends back in
 * history, so both hash alike.
 */
function toolArgumentsText(call: SentToolCall): string {
  return sentArgumentsText(call.failure) ?? JSON.stringify(call.arguments);
}

function toolCallPart(call: ToolCallRequest): TracePart {
  return {
    type: 'tool_call',
    id: call.callId,
    name: call.name,
    arguments: traceContent(toolArgumentsText(call)),
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

type ServerToolStep =
  | { side: 'call'; name: string; id?: string }
  | { side: 'result'; name: string; id?: string };

function serverToolStep(evidence: ProviderEvidence): ServerToolStep | undefined {
  switch (evidence.kind) {
    case 'code_execution_call':
      return { side: 'call', name: 'code_execution', id: evidence.id };
    case 'code_execution_result':
      return { side: 'result', name: 'code_execution', id: evidence.callId };
    case 'provider_step': {
      const { step, raw } = evidence;
      if (step.endsWith(CALL_SUFFIX)) {
        const id = typeof raw?.id === 'string' ? raw.id : undefined;
        return { side: 'call', name: step.slice(0, -CALL_SUFFIX.length), id };
      }
      if (step.endsWith(RESULT_SUFFIX)) {
        const id = typeof raw?.call_id === 'string' ? raw.call_id : undefined;
        return { side: 'result', name: step.slice(0, -RESULT_SUFFIX.length), id };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A provider-run tool step as a semconv server tool part. The kernel sees a
 * step only once it is whole, so its arrival is `theorem.observed_end`; the
 * row events hold every earlier row's arrival.
 */
function serverToolPart(evidence: ProviderEvidence, nowUnixNano: string): TracePart | undefined {
  const step = serverToolStep(evidence);
  if (!step) return undefined;
  const observed = {
    'theorem.observed_end': nowUnixNano,
    ...(evidence.partial ? { 'theorem.partial': true } : {}),
  };
  const payload = { ...traceJson(evidence.raw ?? {}), type: step.name };
  if (step.side === 'call') {
    return {
      type: 'server_tool_call',
      ...optional('id', step.id),
      name: step.name,
      server_tool_call: payload,
      ...observed,
    };
  }
  return {
    type: 'server_tool_call_response',
    ...optional('id', step.id),
    server_tool_call_response: payload,
    ...observed,
  };
}

/** The raw evidence payload is recorded only with `evidenceRaw`. */
function groundingEvent(event: ProviderEvent): TraceAttributes | undefined {
  switch (event.type) {
    case 'grounding': {
      const { searchHtml, metadata, chunks } = event.grounding;
      if (!searchHtml && !metadata && !chunks) return undefined;
      return {
        ...(searchHtml ? { search_html: traceContent(searchHtml) } : {}),
        ...(metadata || chunks ? { raw: traceJson({ metadata, chunks }) } : {}),
      };
    }
    case 'citation':
      return { sources: traceJson(event.sources) };
    case 'evidence': {
      const { evidence } = event;
      if (serverToolStep(evidence)) return undefined;
      if (evidence.kind === 'input_transcription' || evidence.kind === 'output_transcription') {
        return undefined;
      }
      return {
        provider: evidence.provider,
        ...(evidence.raw ? { raw: traceJson(evidence.raw) } : {}),
      };
    }
    default:
      return undefined;
  }
}

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
      ...optional('label', hit.label),
      ...optional('doc', hit.doc),
    })),
    ...(guardrail.provenance ? { provenance: { ...guardrail.provenance } } : {}),
    ...(guardrail.errorInternal ? { error: traceContent(guardrail.errorInternal) } : {}),
  };
}

/**
 * A guardrail check whose time the trace records: the turn's input and output,
 * each tool boundary, the checks that run on streamed output, and a live
 * session's own gates.
 */
type GuardrailCheck =
  | 'input'
  | 'egress'
  | 'tool_arguments'
  | 'taint'
  | 'tool_result'
  | 'tool_failure'
  | 'network'
  | 'network_request'
  | StreamCheck
  | 'live_input';

/**
 * A check that runs many times on one model call's streamed output: the
 * progressive gate on each piece of reply text, the canary scan of every other
 * streamed event, and a live session's gate on each batch it sends.
 */
type StreamCheck = 'output_stream' | 'stream_canary' | 'live_output';

/** What a stream check looked at, for its pass record. */
const STREAM_CHECK_STAGE: Readonly<Record<StreamCheck, GuardrailStage>> = {
  output_stream: 'output_delta',
  stream_canary: 'output_delta',
  live_output: 'live_outbound',
};

/** One stream check's time and runs so far on a call, and whether it has acted. */
interface StreamCheckTime {
  ms: number;
  runs: number;
  decided: boolean;
}

/**
 * One timed guardrail check as `theorem.guardrail` attributes: its decision,
 * or a pass (`allow`, no hits) when it let the text through. Trace only; the
 * host still hears about hits alone.
 */
function guardrailCheckAttributes(
  check: GuardrailCheck,
  durationMs: number,
  guardrail: GuardrailEvent | undefined,
  passed: { stage: GuardrailStage; trust: TrustLevel },
): TraceAttributes {
  return {
    ...(guardrail
      ? guardrailAttributes(guardrail)
      : { stage: passed.stage, trust: passed.trust, action: 'allow', hits: [] }),
    check,
    duration_ms: durationMs,
  };
}

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

function optional(key: string, value: TraceAttributeValue | undefined): TraceAttributes {
  return value === undefined ? {} : { [key]: value };
}

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

function outputType(req: ProviderCompleteRequest, transport: ProviderTransport): string {
  // why: Live answers in audio: its setup asks for `responseModalities: ['AUDIO']` (live/framing.ts).
  if (transport === 'geminiLive') return 'speech';
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
    ...optional('gen_ai.request.temperature', req.temperature),
    ...optional('gen_ai.request.max_tokens', req.maxOutputTokens),
    ...optional('gen_ai.request.reasoning.level', req.thinking),
    ...optional('gen_ai.request.previous_response.id', req.previousInteractionId),
    'gen_ai.system_instructions': [{ type: 'text', ...traceContent(req.system) }],
    ...(req.wireTools?.length
      ? { 'gen_ai.tool.definitions': traceContent(JSON.stringify(req.wireTools)) }
      : {}),
    'gen_ai.output.type': outputType(req, transport),
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
    'theorem.request.builtins': req.builtins.map((b) => b.id),
    ...optional('theorem.request.store', req.store),
    ...optional('theorem.request.summaries', req.summaries),
    ...optional('theorem.request.structured', req.structured?.id),
    ...optional('theorem.request.session_id', req.sessionId),
    ...(cache
      ? { 'theorem.request.cache': { mode: cache.mode, ...optional('ttl', cache.ttl) } }
      : {}),
    ...(image
      ? {
          'theorem.request.image': {
            ...optional('mime_type', image.mimeType),
            ...optional('aspect_ratio', image.aspectRatio),
            ...optional('resolution', image.resolution),
            ...optional('quality', image.quality),
            ...optional('background', image.background),
            ...optional('n', image.n),
            ...optional('seed', image.seed),
            ...optional('output_compression', image.outputCompression),
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
    ...(live.contextCompression
      ? {
          context_compression: {
            mechanism: 'sliding_window',
            ...optional('trigger_tokens', live.contextCompression.triggerTokens),
            ...optional('target_tokens', live.contextCompression.slidingWindow.targetTokens),
          },
        }
      : {}),
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

function headerAttributes(prefix: string, headers: unknown): TraceAttributes {
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [`${prefix}.${key}`, [String(value)]]),
  );
}

function urlAttributes(url: unknown): TraceAttributes {
  if (typeof url !== 'string') return {};
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  // why: The path only: a query can carry credentials.
  return parsed ? { 'server.address': parsed.hostname, 'url.path': parsed.pathname } : {};
}

/** POST spans of one call, opened and closed from the adapter's tap rows. */
class HttpTries {
  private tries = 0;
  private current?: SpanHandle;
  private last?: SpanHandle;
  /** Status of the latest response; how a try still open at call end ended. */
  lastStatus?: number;
  private awaitingFirstChunk = false;
  private streamed = false;

  constructor(private readonly call: SpanHandle) {}

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
    // why: The body sent decides, not the profile: an adapter may stream or buffer regardless.
    this.streamed = asRecord(row.body)?.stream === true;
    if (this.streamed) this.call.set({ 'gen_ai.request.stream': true });
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
      // why: Streamed or buffered, the first data row is the reply's first chunk: a buffered body is its one chunk.
      this.awaitingFirstChunk = true;
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
    return { code: 'ERROR', message: errorKind(thrown) };
  }
  return cancelled ? { code: 'UNSET' } : { code: 'OK' };
}

/** The class a thrown value is recorded under (`exception.type`); `error.type` is its kind. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function recordException(span: SpanHandle, err: unknown): void {
  span.event('exception', {
    'exception.type': errorName(err),
    'exception.message': traceContent(err instanceof Error ? err.message : String(err)),
    ...(err instanceof Error && err.stack
      ? { 'exception.stacktrace': traceContent(err.stack) }
      : {}),
  });
}

/** Close a root that a throw ended: the exception, its kind as `error.type`, and ERROR. */
function endThrownSpan(span: SpanHandle, err: unknown): void {
  recordException(span, err);
  const kind = errorKind(err);
  span.set({ 'error.type': kind });
  span.end({ code: 'ERROR', message: kind });
}

interface CallEnd {
  /** The call's one usage report (estimated sides filled), when there is one. */
  tokens?: TurnTokens;
  stop?: TurnStop;
  /** Thrown out of the stream (not an abort). */
  thrown?: unknown;
}

interface CallTrace {
  span: SpanHandle;
  /** Pass as the adapter's `tapUpstream`. */
  tap: (row: Record<string, unknown>) => void;
  /** Every provider event, before guardrails. */
  observe: (event: ProviderEvent) => void;
  /** A stream check's decision; it carries the time that check has spent on the call so far. */
  guardrail: (event: GuardrailEvent) => void;
  /** Add one run of a stream check to this call. */
  guardTime: (check: StreamCheck, ms: number) => void;
  end: (end: CallEnd) => void;
}

/** Each stream check that ran on a call and never acted, as one pass with its total time and runs. */
function recordStreamPasses(
  span: SpanHandle,
  checks: ReadonlyMap<StreamCheck, StreamCheckTime>,
): void {
  for (const [check, timed] of checks) {
    if (timed.decided) continue;
    span.event('theorem.guardrail', {
      ...guardrailCheckAttributes(check, timed.ms, undefined, {
        stage: STREAM_CHECK_STAGE[check],
        trust: 'untrusted',
      }),
      runs: timed.runs,
    });
  }
}

/** Every stream check's time on a call, summed: `theorem.guardrail.stream_ms`, when any ran. */
function streamGuardMs(checks: ReadonlyMap<StreamCheck, StreamCheckTime>): TraceAttributes {
  let ms = 0;
  for (const timed of checks.values()) ms += timed.ms;
  return ms > 0 ? { 'theorem.guardrail.stream_ms': ms } : {};
}

/** Stops where the model did not finish its output: no finish reason, status `UNSET`. */
const STOPPED_CALLS = new Set<TurnStop['kind']>(['cancelled', 'interrupted']);

function callOutcome(
  stop: TurnStop | undefined,
  failure: ErrorKind | undefined,
): { stopped: boolean; finish?: string; status: TraceSpanStatus; attributes: TraceAttributes } {
  const stopped = stop !== undefined && STOPPED_CALLS.has(stop.kind);
  const finish = stop && !stopped ? (FINISH_REASON[stop.kind] ?? stop.kind) : undefined;
  if (failure) {
    return {
      stopped,
      finish,
      status: { code: 'ERROR', message: failure },
      attributes: { 'error.type': failure },
    };
  }
  return { stopped, finish, status: { code: stopped ? 'UNSET' : 'OK' }, attributes: {} };
}

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
 * `open` places the span: a child of the turn's root, or the root of a Live response's own record.
 * `usage.conversation` is read again at the end, since a Live response sets it only when it closes.
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
  const http = new HttpTries(span);
  const output = new OutputFold();
  const heard = new OutputFold();
  const errors: TurnEventOf<'error'>[] = [];
  let response: TurnResponse | undefined;
  let native: string | undefined;
  let firstText = false;
  const streamChecks = new Map<StreamCheck, StreamCheckTime>();
  /** The stream check that ran last: a decision right after it is that check's. */
  let lastCheck: StreamCheck | undefined;

  return {
    span,
    tap: (row) => {
      if (!http.row(row)) span.event('theorem.upstream.row', { row: traceJson(row) });
    },
    observe: (event) => {
      if (event.type === 'evidence' && event.evidence.kind === 'input_transcription') {
        heard.add(event, span.nowUnixNano());
        return;
      }
      output.add(event, span.nowUnixNano());
      if (event.type === 'text' && !firstText) {
        firstText = true;
        span.set({ 'theorem.response.time_to_first_text': span.msSinceStart() / MS_PER_S });
      }
      const grounding = groundingEvent(event);
      if (grounding) span.event('theorem.grounding', grounding);
      if (event.type === 'error') errors.push(event);
      if (event.type === 'response') response = event.response;
      if (event.type === 'done') native = event.stop.native ?? native;
    },
    guardrail: (guardrail) => {
      const timed = lastCheck ? streamChecks.get(lastCheck) : undefined;
      if (!(lastCheck && timed) || timed.decided) {
        span.event('theorem.guardrail', guardrailAttributes(guardrail));
        return;
      }
      timed.decided = true;
      span.event('theorem.guardrail', {
        ...guardrailCheckAttributes(lastCheck, timed.ms, guardrail, {
          stage: STREAM_CHECK_STAGE[lastCheck],
          trust: 'untrusted',
        }),
        runs: timed.runs,
      });
    },
    guardTime: (check, ms) => {
      const timed = streamChecks.get(check) ?? { ms: 0, runs: 0, decided: false };
      timed.ms += ms;
      timed.runs += 1;
      streamChecks.set(check, timed);
      lastCheck = check;
    },
    end: (end) => {
      for (const error of errors) {
        span.event('exception', {
          'exception.type': error.errorKind,
          'exception.message': traceContent(error.errorInternal ?? error.error ?? ''),
        });
      }
      if (end.thrown !== undefined) recordException(span, end.thrown);
      recordStreamPasses(span, streamChecks);
      const lastError = errors.at(-1);
      const failure = end.thrown !== undefined ? errorKind(end.thrown) : lastError?.errorKind;
      const outcome = callOutcome(end.stop, failure);
      const outputMessage: TraceMessage = {
        role: 'assistant',
        parts: output.parts,
        ...optional('finish_reason', outcome.finish),
      };
      const { input } = inputMessages(usage);
      // why: A continuation replays what the model read, not the provider's transcript of it.
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
        ...streamGuardMs(streamChecks),
        ...outcome.attributes,
      });
      span.end(outcome.status);
    },
  };
}

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

function traceLinks(links: readonly TurnTraceLink[] | undefined): SpanLinkInput[] {
  return (links ?? []).map((link) => ({
    traceparent: link.traceparent,
    attributes: {
      'theorem.link.kind': link.kind,
      ...optional('theorem.stop.kind', link.stop),
    },
  }));
}

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

interface TurnEnd {
  seen: readonly TurnEvent[];
  /** Those events as output parts, folded as they were delivered. */
  delivered: OutputFold;
  /** Validation / egress attempts that made a model call. */
  attempts: number;
  calls: number;
  /** Thrown out of the turn (not an abort). */
  thrown?: unknown;
}

/**
 * Close a turn's `invoke_agent` span. Usage is the sum of this turn's own
 * calls; a nested turn (compaction) carries its own.
 */
function endTurnSpan(root: SpanHandle, end: TurnEnd): void {
  const tokens = sumEventTokens(end.seen);
  const done = findLast(end.seen, (ev): ev is TurnEventOf<'done'> => ev.type === 'done');
  const stop = done?.stop.kind;
  const errorEvent = findLast(end.seen, (ev): ev is TurnEventOf<'error'> => ev.type === 'error');
  const publicError = errorEvent?.error;
  const threw = end.thrown !== undefined;
  if (threw) recordException(root, end.thrown);
  const failed = threw || (stop !== undefined && FAILED_STOPS.has(stop));
  const failure = threw ? errorKind(end.thrown) : (errorEvent?.errorKind ?? stop);
  // why: What the host received, beside each call's `output.messages` (what the model produced).
  const delivered: TraceMessage = {
    role: 'assistant',
    parts: end.delivered.parts,
    ...optional('finish_reason', callOutcome(done?.stop, undefined).finish),
  };
  root.set({
    'gen_ai.output.messages': [delivered],
    ...(tokens ? usageAttributes(tokens) : {}),
    ...(stop ? { 'theorem.stop.kind': stop } : {}),
    'theorem.attempts': end.attempts,
    'theorem.steps': end.calls,
    ...(end.seen.some((ev) => ev.type === 'compaction' && ev.outcome === 'compacted')
      ? { 'gen_ai.conversation.compacted': true }
      : {}),
    ...(failed && publicError ? { 'theorem.error.public': traceContent(publicError) } : {}),
    ...(failed && failure ? { 'error.type': failure } : {}),
  });
  if (failed) {
    root.end({ code: 'ERROR', ...(failure ? { message: failure } : {}) });
  } else {
    root.end(stop && !FINISHED_STOPS.has(stop) ? { code: 'UNSET' } : { code: 'OK' });
  }
}

export type { CallEnd, CallTrace, GuardrailCheck, SentToolCall, StreamCheck, TracePart, TurnEnd };
export {
  endThrownSpan,
  endTurnSpan,
  guardrailAttributes,
  guardrailCheckAttributes,
  OutputFold,
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
