/**
 * Minimal v3 trace records and spans for sink and writer tests.
 */
import { DEFAULT_RETAIN_DAYS } from '../../src/observability/resolve-policy.ts';
import { TRACE_SCHEMA_URL, type TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceWriteContext } from '../../src/observability/trace-sink.ts';
import type { TraceSpan } from '../../src/observability/trace-span.ts';

/** The write context a default policy hands every sink. */
const STUB_WRITE: TraceWriteContext = { retainForDays: DEFAULT_RETAIN_DAYS };

function stubRecord(): TraceRecord {
  return { v: 3, schemaUrl: TRACE_SCHEMA_URL, resource: {}, spans: [], content: {} };
}

/** A closed root span with no attributes, for tests that set only its ids. */
function stubSpan(): TraceSpan {
  return {
    traceId: '0'.repeat(32),
    spanId: '0'.repeat(16),
    name: 'invoke_agent stub',
    kind: 'INTERNAL',
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    attributes: {},
    events: [],
    links: [],
    status: { code: 'UNSET' },
  };
}

export { STUB_WRITE, stubRecord, stubSpan };
