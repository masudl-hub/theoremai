/**
 * Trace sinks, destination registry, profile observability policy, and the
 * span builder the kernel itself uses.
 *
 * THEOREM does not own a database or environment variable. Host applications
 * register named destinations, declare `profile.observability`, and/or pass a
 * sink into `runTurn`. Hosts record their own spans with `startTrace`, seal
 * them with `buildRecord`, and read stored content back with `contentOf`.
 *
 * @module
 */

export type {
  JsonlTraceDestination,
  TraceDestination,
} from './destinations.ts';
export {
  clearTraceDestinations,
  getTraceDestination,
  isJsonlTraceDestination,
  isTraceSink,
  jsonlDestination,
  listTraceDestinationIds,
  registerTraceDestination,
  requireTraceDestination,
} from './destinations.ts';
export type { OtlpAnyValue, OtlpKeyValue, OtlpSpan, OtlpTraceRequest } from './otlp.ts';
export { toOtlpJson } from './otlp.ts';
export { resolveTraceWriter } from './policy.ts';
export { resolveObservabilityPolicy } from './resolve-policy.ts';
export type { JsonlSinkOptions } from './trace.ts';
export {
  jsonlSink,
  memorySink,
  noopSink,
  writeTrace,
} from './trace.ts';
export type { TraceRecord } from './trace-record.ts';
export { buildRecord, contentOf, inlineContent } from './trace-record.ts';
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
export { startTrace, traceBytes, traceContent, traceJson } from './trace-span.ts';
export type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  TraceIncludeSpec,
  TraceScrubSpec,
} from './types.ts';
