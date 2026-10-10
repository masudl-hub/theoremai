// why: OTLP has no record-level slot for `TraceRecord.metadata` (the resource is the service's
// identity), so each key lands on the record's top spans as `theorem.metadata.<key>`.

import { inlineContent, type TraceRecord } from './trace-record.ts';
import type { TraceSpan, TraceSpanKind, TraceSpanStatus } from './trace-span.ts';

/** An OTLP/JSON attribute value. */
type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } };

/** An OTLP/JSON attribute: a key and its value. */
interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** A span as OTLP/JSON carries it. */
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events: { timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }[];
  links: { traceId: string; spanId: string; attributes: OtlpKeyValue[] }[];
  status: { code: number; message?: string };
}

/** An OTLP/JSON `ExportTraceServiceRequest` (the body of `POST /v1/traces`). */
interface OtlpTraceRequest {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: {
      scope: { name: string };
      schemaUrl: string;
      spans: OtlpSpan[];
    }[];
  }[];
}

const SCOPE_NAME = '@theoremjs/agents';

const SPAN_KIND: Record<TraceSpanKind, number> = { INTERNAL: 1, CLIENT: 3 };

const STATUS_CODE: Record<TraceSpanStatus['code'], number> = { UNSET: 0, OK: 1, ERROR: 2 };

function anyValue(value: unknown): OtlpAnyValue | undefined {
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    // why: int64 is a decimal string in OTLP/JSON.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.flatMap((item) => anyValue(item) ?? []) } };
  }
  if (value && typeof value === 'object') {
    return { kvlistValue: { values: keyValues(value) } };
  }
  // why: null / undefined: OTLP has no empty value, so the key is left out.
  return undefined;
}

function keyValues(fields: object): OtlpKeyValue[] {
  return Object.entries(fields).flatMap(([key, field]) => {
    const value = anyValue(field);
    return value ? [{ key, value }] : [];
  });
}

function inlined(record: TraceRecord, attributes: object): OtlpKeyValue[] {
  return keyValues(inlineContent(record, attributes) as object);
}

const METADATA_PREFIX = 'theorem.metadata.';

function metadataAttributes(record: TraceRecord): OtlpKeyValue[] {
  return keyValues(record.metadata ?? {}).map(({ key, value }) => ({
    key: `${METADATA_PREFIX}${key}`,
    value,
  }));
}

/** Includes the root, which may hang under a host `traceparent` span that lives elsewhere. */
function topSpanIds(record: TraceRecord): Set<string> {
  const ids = new Set(record.spans.map((span) => span.spanId));
  return new Set(
    record.spans
      .filter((span) => !(span.parentSpanId && ids.has(span.parentSpanId)))
      .map((span) => span.spanId),
  );
}

function otlpSpan(record: TraceRecord, span: TraceSpan, metadata: OtlpKeyValue[]): OtlpSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: SPAN_KIND[span.kind],
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: [...inlined(record, span.attributes), ...metadata],
    events: span.events.map((event) => ({
      timeUnixNano: event.timeUnixNano,
      name: event.name,
      attributes: inlined(record, event.attributes),
    })),
    links: span.links.map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: inlined(record, link.attributes),
    })),
    status: {
      code: STATUS_CODE[span.status.code],
      ...(span.status.message ? { message: span.status.message } : {}),
    },
  };
}

/**
 * One resource per record, one scope, with every stored reference inlined. For a backend that
 * takes protobuf only, send this through an OpenTelemetry Collector.
 */
function toOtlpJson(records: readonly TraceRecord[]): OtlpTraceRequest {
  return {
    resourceSpans: records.map((record) => {
      const top = topSpanIds(record);
      const metadata = metadataAttributes(record);
      return {
        resource: { attributes: keyValues(record.resource) },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            schemaUrl: record.schemaUrl,
            spans: record.spans.map((span) =>
              otlpSpan(record, span, top.has(span.spanId) ? metadata : []),
            ),
          },
        ],
      };
    }),
  };
}

export type { OtlpAnyValue, OtlpKeyValue, OtlpSpan, OtlpTraceRequest };
export { toOtlpJson };
