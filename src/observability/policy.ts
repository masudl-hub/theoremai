/**
 * Trace writer resolution — a resolved observability policy becomes a sink.
 *
 * Policy defaults live in `resolve-policy.ts` (pure); this module owns the
 * writer precedence and needs the sink implementations.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import { isJsonlTraceDestination, isTraceSink, requireTraceDestination } from './destinations.ts';
import { resolveObservabilityPolicy } from './resolve-policy.ts';
import { jsonlSink, noopSink } from './trace.ts';
import type { TraceRecord } from './trace-record.ts';
import type { TraceSink } from './trace-sink.ts';
import type { ProfileObservabilitySpec, ResolvedObservabilityPolicy } from './types.ts';

function bindOnWriteError(sink: TraceSink, onWriteError?: (err: unknown) => void): TraceSink {
  if (!onWriteError && !sink.onError) {
    return sink;
  }
  return {
    write: (record, context) => sink.write(record, context),
    onError: sink.onError ?? onWriteError,
  };
}

/** Trace-id bits the sampling decision reads: the low 32 (8 hex digits). */
const SAMPLE_HEX_DIGITS = 8;
const SAMPLE_SPACE = 2 ** 32;

/**
 * Keep a record when its trace is sampled. The decision is a function of the
 * trace id (OpenTelemetry `TraceIdRatioBased`), so every record of one trace
 * (a turn, its specialists, a Live session's responses and tools, a host's
 * cutout) is kept or dropped together, in any process.
 */
function traceSampled(record: TraceRecord, sampleRate: number): boolean {
  const traceId = record.spans[0]?.traceId ?? '';
  return Number.parseInt(traceId.slice(-SAMPLE_HEX_DIGITS), 16) / SAMPLE_SPACE < sampleRate;
}

function withSampleRate(sink: TraceSink, sampleRate: number): TraceSink {
  if (sampleRate >= 1) {
    return sink;
  }
  if (sampleRate <= 0) {
    return noopSink();
  }
  return {
    write: async (record, context) => {
      if (traceSampled(record, sampleRate)) {
        await sink.write(record, context);
      }
    },
    onError: sink.onError,
  };
}

function sinkFromWriteTo(
  writeTo: false | string | TraceSink | undefined,
  policy: ResolvedObservabilityPolicy,
): TraceSink {
  if (writeTo === undefined || writeTo === false) {
    return noopSink();
  }
  if (typeof writeTo !== 'string') {
    return bindOnWriteError(writeTo, policy.onWriteError);
  }
  const destination = requireTraceDestination(writeTo);
  if (isJsonlTraceDestination(destination)) {
    return bindOnWriteError(
      jsonlSink(destination.dir, { rotateAfterMiB: policy.rotateAfterMiB }),
      policy.onWriteError,
    );
  }
  if (!isTraceSink(destination)) {
    throw new TheoremError('config', `Trace destination '${writeTo}' is not a usable writer`);
  }
  return bindOnWriteError(destination, policy.onWriteError);
}

/**
 * Resolve the TraceSink for one turn.
 *
 * Precedence: explicit `override` (runTurn third arg) → profile `writeTo` → noop.
 * An explicit override always records (sampleRate does not apply) so tests and
 * one-off capture are deterministic.
 */
function resolveTraceWriter(args: {
  override?: TraceSink;
  observability?: ProfileObservabilitySpec;
}): { sink: TraceSink; policy: ResolvedObservabilityPolicy } {
  const policy = resolveObservabilityPolicy(args.observability);
  if (args.override) {
    return {
      policy,
      sink: bindOnWriteError(args.override, policy.onWriteError),
    };
  }
  if (!policy.record) {
    return { policy, sink: noopSink() };
  }
  return {
    policy,
    sink: withSampleRate(sinkFromWriteTo(policy.writeTo, policy), policy.sampleRate),
  };
}

export { resolveTraceWriter };
