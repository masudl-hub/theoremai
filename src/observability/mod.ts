/**
 * Trace sinks, destination registry, and profile observability policy.
 *
 * THEORUM does not own a database or environment variable. Host applications
 * register named destinations, declare `profile.observability`, and/or pass a
 * sink into `runTurn`.
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
export { resolveObservabilityPolicy, resolveTraceWriter } from './policy.ts';
export type { JsonlSinkOptions, TraceSink } from './trace.ts';
export {
  jsonlSink,
  memorySink,
  noopSink,
  resolveTraceDir,
  sinkFromDir,
  writeTrace,
} from './trace.ts';
export type { TraceRecord } from './trace-record.ts';
export type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  TraceIncludeSpec,
  TraceScrubSpec,
} from './types.ts';
