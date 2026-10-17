// invariant: Each type is checked against its zod schema (`Equals`), so a field in one and not the other fails
// the build. A record crosses a wire, so a reader parses it with `traceRecordSchema` first.

import { z } from 'zod';
import type { Equals } from '../kernel/util/exact-type.ts';

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

/** A span's or event's attributes, by name. */
export type TraceAttributes = Record<string, TraceAttributeValue>;
const traceAttributes = z.record(z.string(), traceAttributeValue);
true satisfies Equals<z.infer<typeof traceAttributes>, TraceAttributes>;
export const traceAttributesSchema: z.ZodType<TraceAttributes> = traceAttributes;

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

/** A timestamped event on a span, with its attributes. */
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

/** One span of a trace: its ids, name, kind, times, attributes, events, links and status. */
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
