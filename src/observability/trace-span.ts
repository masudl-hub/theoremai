// Content is held in memory as markers the record builder resolves: `$content` is scrubbed, hashed
// and moved into `TraceRecord.content`; `$bytes` is hashed and never stored; `$json` has media
// hashed and strings equal to recorded content replaced by their hash.

import { TheoremError } from '../guardrails/error.ts';
import { isRecord } from '../kernel/util/record.ts';
import type {
  TraceAttributes,
  TraceAttributeValue,
  TraceSpan,
  TraceSpanEvent,
  TraceSpanKind,
  TraceSpanLink,
  TraceSpanStatus,
} from './trace-schema.ts';

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

interface SpanLinkInput {
  traceparent: string;
  attributes?: TraceAttributes;
}

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
  /** True once `end` ran or the trace was collected. */
  readonly ended: boolean;
  traceparent: () => string;
  child: (name: string, options?: SpanOptions) => SpanHandle;
  /** Merge attributes; later values win. Ignored after `end`. */
  set: (attributes: TraceAttributes) => void;
  /**
   * Append a timestamped event. `timeUnixNano` places an event observed before
   * it could be attached (default: now). Ignored after `end`.
   */
  event: (name: string, attributes?: TraceAttributes, timeUnixNano?: string) => void;
  /** Default status is `OK`. Second and later calls are ignored. */
  end: (status?: TraceSpanStatus) => void;
  msSinceStart: () => number;
  /** Milliseconds from this span's end to now; `undefined` while open. */
  msSinceEnd: () => number | undefined;
  /** Now on the trace's clock, as span timestamps are written. */
  nowUnixNano: () => string;
}

interface TraceTree {
  root: SpanHandle;
  /** The trace's clock; pass it to `startTrace` so related trees share one timeline. */
  clock: TraceClock;
  /** Closes anything still open as `ERROR` / `unclosed`; returns root first, then start order. */
  collect: () => TraceSpan[];
}

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

/** On Cloudflare Workers both clocks advance only at I/O; the root carries `theorem.clock=io`. */
function systemClock(): TraceClock {
  const epochMs = Date.now();
  const perfStart = performance.now();
  return {
    nowUnixNano: () =>
      BigInt(epochMs) * BigInt(NANOS_PER_MS) +
      BigInt(Math.round((performance.now() - perfStart) * NANOS_PER_MS)),
  };
}

function clockAdvancesOnlyAtIo(): boolean {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers';
}

/**
 * The trace and span ids of a W3C `traceparent` THEOREM accepts (version 00,
 * lowercase hex, non-zero ids), or `undefined`. For a host checking a value from
 * a request before handing it to a turn, which throws on anything else.
 */
function readTraceparent(value: string): { traceId: string; spanId: string } | undefined {
  const match = TRACEPARENT.exec(value.trim());
  const traceId = match?.[1];
  const spanId = match?.[2];
  if (!traceId || !spanId || ALL_ZERO.test(traceId) || ALL_ZERO.test(spanId)) return undefined;
  return { traceId, spanId };
}

/** Throws on a malformed value: a host bug, not a runtime state. */
function parseTraceparent(value: string): { traceId: string; spanId: string } {
  const parsed = readTraceparent(value);
  if (!parsed) {
    throw new TheoremError('request', `traceparent is not a valid W3C trace context: '${value}'`);
  }
  return parsed;
}

function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-${SAMPLED_FLAGS}`;
}

function traceContent(text: string): TraceContent {
  return { $content: text };
}

function traceBytes(base64: string): TraceBytes {
  return { $bytes: base64 };
}

/** `undefined` members and non-JSON values are dropped the way `JSON.stringify` drops them. */
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
  return isRecord(value) && key in value;
}

function isTraceContent(value: unknown): value is TraceContent {
  return isMarker(value, '$content') && typeof value.$content === 'string';
}

function isTraceBytes(value: unknown): value is TraceBytes {
  return isMarker(value, '$bytes') && typeof value.$bytes === 'string';
}

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
  readTraceparent,
  startTrace,
  traceBytes,
  traceContent,
  traceJson,
};
