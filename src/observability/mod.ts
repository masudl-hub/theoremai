/**
 * Trace sinks, the destination registry, observability policy, the span builder and the trace
 * catalog. THEOREM owns no database: hosts register destinations or pass a sink into `runTurn`.
 *
 * @module
 */

export {
  clearTraceDestinations,
  getTraceDestination,
  isTraceSink,
  listTraceDestinationIds,
  registerTraceDestination,
  requireTraceDestination,
} from './destinations.ts';
export type { OtlpAnyValue, OtlpKeyValue, OtlpSpan, OtlpTraceRequest } from './otlp.ts';
export { toOtlpJson } from './otlp.ts';
export { resolveTraceWriter } from './policy.ts';
export { resolveObservabilityPolicy } from './resolve-policy.ts';
export {
  memorySink,
  noopSink,
  writeTrace,
} from './trace.ts';
export type {
  TraceAttributeGroup,
  TraceAttributeMeta,
  TraceEventMeta,
  TraceOptionMeta,
  TraceSpanMeta,
  TraceSpanType,
  TraceValueFormat,
} from './trace-catalog.ts';
export {
  TRACE_ATTRIBUTE_GROUPS,
  TRACE_FIELDS,
  TRACE_SPAN_TYPES,
  TRACE_STATUS,
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
  traceSpanMeta,
} from './trace-catalog.ts';
export type { TraceRecord } from './trace-record.ts';
export { buildRecord, contentOf, inlineContent } from './trace-record.ts';
export { traceRecordSchema } from './trace-schema.ts';
export type { TraceSink, TraceWriteContext } from './trace-sink.ts';
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
} from './trace-span.ts';
export {
  readTraceparent,
  startTrace,
  traceBytes,
  traceContent,
  traceJson,
} from './trace-span.ts';
export type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  TraceIncludeSpec,
  TraceScrubSpec,
} from './types.ts';
