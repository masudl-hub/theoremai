/**
 * Trace sinks, destination registry, and profile observability policy.
 *
 * THEOREM does not own a database or environment variable. Host applications
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
export { resolveTraceWriter } from './policy.ts';
export { resolveObservabilityPolicy } from './resolve-policy.ts';
export type { JsonlSinkOptions } from './trace.ts';
export {
  jsonlSink,
  memorySink,
  noopSink,
  resolveTraceDir,
  sinkFromDir,
  writeTrace,
} from './trace.ts';
export type { TraceRecord } from './trace-record.ts';
export type { TraceSink } from './trace-sink.ts';
export type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  TraceIncludeSpec,
  TraceScrubSpec,
} from './types.ts';
