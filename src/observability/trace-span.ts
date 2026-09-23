/**
 * Span builder — the one way THEOREM and host applications open, nest, and
 * close trace spans.
 *
 * Spans are plain data shaped like OTLP/JSON (`startTimeUnixNano`, `spanId`,
 * …). The kernel stamps spans at its own checkpoints; hosts use the same
 * builder for their own steps and link to a turn through W3C `traceparent`.
 *
 * Content is held in memory as markers the record builder resolves:
 * - `traceContent(text)` → `{ $content }`: scrubbed, hashed, moved into
 *   `TraceRecord.content`, so a stored span never carries inline text.
 * - `traceBytes(base64)` → `{ $bytes }`: hashed over the raw bytes; the bytes
 *   are never stored.
 * - `traceJson(value)` → `{ $json }`: a provider row or wire body; media is
 *   hashed, strings equal to recorded content become their hash, and the
 *   result is stored by hash like any other text.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';

/** JSON-shaped attribute value (OTLP `AnyValue`). */
type TraceAttributeValue =
  | null
  | string
  | number
  | boolean
  | TraceAttributeValue[]
  | { [key: string]: TraceAttributeValue };

/** Span or event attributes keyed by semantic-convention name. */
type TraceAttributes = Record<string, TraceAttributeValue>;

/** In-memory text awaiting scrub + hash at record build. */
interface TraceContent {
  [key: string]: TraceAttributeValue;
  $content: string;
}

/** In-memory base64 bytes awaiting hash at record build. */
interface TraceBytes {
  [key: string]: TraceAttributeValue;
  $bytes: string;
}

/** In-memory provider row or wire body awaiting scrub, intern and hash at record build. */
interface TraceJson {
  [key: string]: TraceAttributeValue;
  $json: TraceAttributeValue;
}

/** OTLP span kind. THEOREM emits INTERNAL (agent, tool) and CLIENT (model call). */
type TraceSpanKind = 'INTERNAL' | 'CLIENT';

/** OTLP status. `UNSET` is used for cancelled and paused spans. */
interface TraceSpanStatus {
  code: 'OK' | 'ERROR' | 'UNSET';
  message?: string;
}

/** Edge to a span in an earlier trace (resume, continue, retry). */
interface TraceSpanLink {
  traceId: string;
  spanId: string;
  attributes: TraceAttributes;
}

/** Timestamped annotation on a span. */
interface TraceSpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: TraceAttributes;
}

/** One closed span. */
interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: TraceSpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: TraceAttributes;
  events: TraceSpanEvent[];
  links: TraceSpanLink[];
  status: TraceSpanStatus;
}

/** A link request: the linked span's W3C `traceparent` plus link attributes. */
interface SpanLinkInput {
  traceparent: string;
  attributes?: TraceAttributes;
}

/** Options when opening a span. */
interface SpanOptions {
  kind?: TraceSpanKind;
  attributes?: TraceAttributes;
  links?: SpanLinkInput[];
  /** When the span began, for work measured before the span was opened. Default: now. */
  startTimeUnixNano?: string;
}

/** Handle to an open span. Every method is safe to call after `end`. */
interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  /** True once `end` ran (or the trace was collected). */
  readonly ended: boolean;
  /** W3C `traceparent` naming this span as the parent. */
  traceparent: () => string;
  /** Open a child span in the same trace. */
  child: (name: string, options?: SpanOptions) => SpanHandle;
  /** Merge attributes; later values win. Ignored after `end`. */
  set: (attributes: TraceAttributes) => void;
  /**
   * Append a timestamped event. `timeUnixNano` places an event observed before
   * it could be attached (default: now). Ignored after `end`.
   */
  event: (name: string, attributes?: TraceAttributes, timeUnixNano?: string) => void;
  /** Close the span. Default status is `OK`. Second and later calls are ignored. */
  end: (status?: TraceSpanStatus) => void;
  /** Milliseconds from this span's start to now. */
  msSinceStart: () => number;
  /** Milliseconds from this span's end to now; `undefined` while open. */
  msSinceEnd: () => number | undefined;
  /** Now on the trace's clock, as span timestamps are written. */
  nowUnixNano: () => string;
}

/** Root span plus the collection of every span opened under it. */
interface TraceTree {
  root: SpanHandle;
  /** The trace's clock; pass it to `startTrace` so related trees share one timeline. */
  clock: TraceClock;
  /**
   * Close anything still open as `ERROR` / `unclosed`, then return every span:
   * root first, the rest in start order.
   */
  collect: () => TraceSpan[];
}

/** Monotonic unix-nanosecond clock anchored once per trace. */
interface TraceClock {
  nowUnixNano: () => bigint;
}

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const NANOS_PER_MS = 1_000_000;
const HEX_PAD = 2;
const HEX_RADIX = 16;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO = /^0+$/;
const SAMPLED_FLAGS = '01';
const UNCLOSED = 'unclosed';

function randomHex(bytes: number): string {
  for (;;) {
    const buf = crypto.getRandomValues(new Uint8Array(bytes));
    const hex = [...buf].map((b) => b.toString(HEX_RADIX).padStart(HEX_PAD, '0')).join('');
    if (!ALL_ZERO.test(hex)) {
      return hex;
    }
  }
}

/**
 * Wall-clock epoch at trace start plus `performance.now()` for durations.
 *
 * On Cloudflare Workers both clocks advance only at I/O; spans there measure to
 * I/O boundaries and the root carries `theorem.clock=io`.
 */
function systemClock(): TraceClock {
  const epochMs = Date.now();
  const perfStart = performance.now();
  return {
    nowUnixNano: () =>
      BigInt(epochMs) * BigInt(NANOS_PER_MS) +
      BigInt(Math.round((performance.now() - perfStart) * NANOS_PER_MS)),
  };
}

/** True inside a Cloudflare Worker, where clocks advance only at I/O. */
function clockAdvancesOnlyAtIo(): boolean {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers';
}

/** Parse a W3C `traceparent`. Throws on a malformed value — a host bug, not a runtime state. */
function parseTraceparent(value: string): { traceId: string; spanId: string } {
  const match = TRACEPARENT.exec(value.trim());
  const traceId = match?.[1];
  const spanId = match?.[2];
  if (!traceId || !spanId || ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) {
    throw new TheoremError(`traceparent is not a valid W3C trace context: '${value}'`);
  }
  return { traceId, spanId };
}

function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-${SAMPLED_FLAGS}`;
}

/** Mark text for scrub + hash at record build. */
function traceContent(text: string): TraceContent {
  return { $content: text };
}

/** Mark base64 media bytes for hashing at record build. */
function traceBytes(base64: string): TraceBytes {
  return { $bytes: base64 };
}

/**
 * Mark a provider row or wire body for scrub, intern and hash at record build.
 * `undefined` members and non-JSON values are dropped the way `JSON.stringify`
 * drops them.
 */
function traceJson(value: unknown): TraceJson {
  return { $json: toAttributeValue(value) ?? null };
}

function toAttributeValue(value: unknown): TraceAttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toAttributeValue(item) ?? null);
  }
  if (typeof value === 'object') {
    const out: Record<string, TraceAttributeValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      const mapped = toAttributeValue(nested);
      if (mapped !== undefined) {
        out[key] = mapped;
      }
    }
    return out;
  }
  return undefined;
}

function isMarker(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value;
}

/** True for an in-memory `traceContent` wrapper. */
function isTraceContent(value: unknown): value is TraceContent {
  return isMarker(value, '$content') && typeof value.$content === 'string';
}

/** True for an in-memory `traceBytes` wrapper. */
function isTraceBytes(value: unknown): value is TraceBytes {
  return isMarker(value, '$bytes') && typeof value.$bytes === 'string';
}

/** True for an in-memory `traceJson` wrapper. */
function isTraceJson(value: unknown): value is TraceJson {
  return isMarker(value, '$json');
}

function linkFrom(input: SpanLinkInput): TraceSpanLink {
  const { traceId, spanId } = parseTraceparent(input.traceparent);
  return { traceId, spanId, attributes: { ...(input.attributes ?? {}) } };
}

function msBetween(fromUnixNano: string, clock: TraceClock): number {
  return Number(clock.nowUnixNano() - BigInt(fromUnixNano)) / NANOS_PER_MS;
}

interface OpenSpan {
  span: TraceSpan;
  ended: boolean;
  order: number;
}

function openHandle(
  state: { clock: TraceClock; open: OpenSpan[] },
  traceId: string,
  parentSpanId: string | undefined,
  name: string,
  options: SpanOptions | undefined,
): SpanHandle {
  const entry: OpenSpan = {
    span: {
      traceId,
      spanId: randomHex(SPAN_ID_BYTES),
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      kind: options?.kind ?? 'INTERNAL',
      startTimeUnixNano: options?.startTimeUnixNano ?? String(state.clock.nowUnixNano()),
      endTimeUnixNano: '',
      attributes: { ...(options?.attributes ?? {}) },
      events: [],
      links: (options?.links ?? []).map(linkFrom),
      status: { code: 'UNSET' },
    },
    ended: false,
    order: state.open.length,
  };
  state.open.push(entry);
  const { span } = entry;
  return {
    traceId,
    spanId: span.spanId,
    get ended() {
      return entry.ended;
    },
    traceparent: () => formatTraceparent(traceId, span.spanId),
    child: (childName, childOptions) =>
      openHandle(state, traceId, span.spanId, childName, childOptions),
    set: (attributes) => {
      if (!entry.ended) {
        Object.assign(span.attributes, attributes);
      }
    },
    event: (eventName, attributes, timeUnixNano) => {
      if (!entry.ended) {
        span.events.push({
          name: eventName,
          timeUnixNano: timeUnixNano ?? String(state.clock.nowUnixNano()),
          attributes: { ...(attributes ?? {}) },
        });
      }
    },
    end: (status) => {
      if (entry.ended) {
        return;
      }
      entry.ended = true;
      span.endTimeUnixNano = String(state.clock.nowUnixNano());
      span.status = status ?? { code: 'OK' };
    },
    msSinceStart: () => msBetween(span.startTimeUnixNano, state.clock),
    msSinceEnd: () => (entry.ended ? msBetween(span.endTimeUnixNano, state.clock) : undefined),
    nowUnixNano: () => String(state.clock.nowUnixNano()),
  };
}

/**
 * Open a root span. With `traceparent`, the root joins that trace as a child of
 * the named span; without it, the root starts a new trace.
 */
function startTrace(
  name: string,
  options: SpanOptions & { traceparent?: string; clock?: TraceClock } = {},
): TraceTree {
  const parent = options.traceparent ? parseTraceparent(options.traceparent) : undefined;
  const state = { clock: options.clock ?? systemClock(), open: [] as OpenSpan[] };
  const root = openHandle(
    state,
    parent?.traceId ?? randomHex(TRACE_ID_BYTES),
    parent?.spanId,
    name,
    {
      ...options,
      attributes: {
        ...(clockAdvancesOnlyAtIo() ? { 'theorem.clock': 'io' } : {}),
        ...(options.attributes ?? {}),
      },
    },
  );
  return {
    root,
    clock: state.clock,
    collect: () => {
      const now = String(state.clock.nowUnixNano());
      for (const entry of state.open) {
        if (!entry.ended) {
          entry.ended = true;
          entry.span.endTimeUnixNano = now;
          entry.span.status = { code: 'ERROR', message: UNCLOSED };
        }
      }
      return [...state.open].sort((a, b) => a.order - b.order).map((entry) => entry.span);
    },
  };
}

export type {
  SpanHandle,
  SpanLinkInput,
  SpanOptions,
  TraceAttributes,
  TraceAttributeValue,
  TraceBytes,
  TraceClock,
  TraceContent,
  TraceJson,
  TraceSpan,
  TraceSpanEvent,
  TraceSpanKind,
  TraceSpanLink,
  TraceSpanStatus,
  TraceTree,
};
export {
  formatTraceparent,
  isTraceBytes,
  isTraceContent,
  isTraceJson,
  parseTraceparent,
  startTrace,
  traceBytes,
  traceContent,
  traceJson,
};
