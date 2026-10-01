import { requireTraceDestination } from './destinations.ts';
import { resolveObservabilityPolicy } from './resolve-policy.ts';
import { noopSink } from './trace.ts';
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
 * Decided by trace id (OpenTelemetry `TraceIdRatioBased`), so every record of one trace (a turn,
 * its specialists, a Live session's responses, a host's cutout) is kept or dropped together.
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
  return bindOnWriteError(requireTraceDestination(writeTo), policy.onWriteError);
}

/**
 * Precedence: explicit `override` (runTurn's third arg), then profile `writeTo`, then noop. An
 * override always records, ignoring `sampleRate`, so tests and one-off capture are deterministic.
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
