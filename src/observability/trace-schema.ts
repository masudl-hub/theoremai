/**
 * Trace record shapes. Each is a documented type and a zod schema checked
 * against it (`Equals`): the type is what builders read; the schema is what a
 * reader runs. A field in one and not the other fails the build.
 *
 * A trace record crosses a wire (the live relay's `trace` envelope), so a
 * reader parses it with `traceRecordSchema` before touching it.
 *
 * @module
 */

import { z } from 'zod';
import type { Equals } from '../kernel/util/exact-type.ts';

/** Version of the trace record format. */
export const TRACE_VERSION = 3;

/** JSON-shaped attribute value (OTLP `AnyValue`). */
export type TraceAttributeValue =
  | null
  | string
  | number
  | boolean
  | TraceAttributeValue[]
  | { [key: string]: TraceAttributeValue };
const traceAttributeValue: z.ZodType<TraceAttributeValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(traceAttributeValue),
    z.record(z.string(), traceAttributeValue),
  ]),
);

/** Span or event attributes keyed by semantic-convention name. */
export type TraceAttributes = Record<string, TraceAttributeValue>;
const traceAttributes = z.record(z.string(), traceAttributeValue);
true satisfies Equals<z.infer<typeof traceAttributes>, TraceAttributes>;

/** OTLP span kind. THEOREM emits INTERNAL (agent, tool) and CLIENT (model call). */
export type TraceSpanKind = 'INTERNAL' | 'CLIENT';
const traceSpanKind = z.enum(['INTERNAL', 'CLIENT']);
true satisfies Equals<z.infer<typeof traceSpanKind>, TraceSpanKind>;

/** OTLP status. `UNSET` is used for cancelled and paused spans. */
export interface TraceSpanStatus {
  code: 'OK' | 'ERROR' | 'UNSET';
  message?: string;
}
const traceSpanStatus = z.object({
  code: z.enum(['OK', 'ERROR', 'UNSET']),
  message: z.string().optional(),
});
true satisfies Equals<z.infer<typeof traceSpanStatus>, TraceSpanStatus>;

/** Edge to a span in an earlier trace (resume, continue, retry). */
export interface TraceSpanLink {
  traceId: string;
  spanId: string;
  attributes: TraceAttributes;
}
const traceSpanLink = z.object({
  traceId: z.string(),
  spanId: z.string(),
  attributes: traceAttributes,
});
true satisfies Equals<z.infer<typeof traceSpanLink>, TraceSpanLink>;

/** Timestamped annotation on a span. */
export interface TraceSpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: TraceAttributes;
}
const traceSpanEvent = z.object({
  name: z.string(),
  timeUnixNano: z.string(),
  attributes: traceAttributes,
});
true satisfies Equals<z.infer<typeof traceSpanEvent>, TraceSpanEvent>;

/** One closed span. */
export interface TraceSpan {
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
const traceSpan = z.object({
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: traceSpanKind,
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: traceAttributes,
  events: z.array(traceSpanEvent),
  links: z.array(traceSpanLink),
  status: traceSpanStatus,
});
true satisfies Equals<z.infer<typeof traceSpan>, TraceSpan>;

/** One trace record: a turn, a host-invoked tool, or a Live session root or response. */
export interface TraceRecord {
  v: typeof TRACE_VERSION;
  schemaUrl: string;
  /** Host-supplied process attributes (`observability.resource`), e.g. `service.name`. */
  resource: TraceAttributes;
  /** Host-owned metadata from the request, passed through untouched. */
  metadata?: Record<string, unknown>;
  /** Root first, then in start order. */
  spans: TraceSpan[];
  /** sha256 hex → exact scrubbed text; every hash the spans reference. */
  content: Record<string, string>;
}
const traceRecord = z.object({
  v: z.literal(TRACE_VERSION),
  schemaUrl: z.string(),
  resource: traceAttributes,
  metadata: z.record(z.string(), z.unknown()).optional(),
  spans: z.array(traceSpan),
  content: z.record(z.string(), z.string()),
});
true satisfies Equals<z.infer<typeof traceRecord>, TraceRecord>;
/** What a reader runs on a trace record from a wire; other versions fail. */
export const traceRecordSchema: z.ZodType<TraceRecord> = traceRecord;
