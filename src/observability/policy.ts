/**
 * Observability policy resolution — profile switches become defaults + a writer.
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
import { isJsonlTraceDestination, isTraceSink, requireTraceDestination } from './destinations.ts';
import { jsonlSink, noopSink, type TraceSink } from './trace.ts';
import type {
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
} from './types.ts';

const DEFAULT_RETAIN_DAYS = 14;
const DEFAULT_ROTATE_MIB = 32;

function resolveInclude(spec: ProfileObservabilitySpec | undefined): ResolvedTraceInclude {
  // When no observability block is authored, preserve historical buildRecord
  // behavior (wire + evidence included). Authored blocks default those off.
  const authored = spec !== undefined;
  return {
    upstreamLog: spec?.include?.upstreamLog ?? true,
    outboundWire: spec?.include?.outboundWire ?? !authored,
    evidenceRaw: spec?.include?.evidenceRaw ?? !authored,
    usage: spec?.include?.usage ?? true,
    guardrailDecisions: spec?.include?.guardrailDecisions ?? true,
    guardrailMatchPreview: spec?.include?.guardrailMatchPreview ?? false,
  };
}

function resolveScrub(spec: ProfileObservabilitySpec | undefined): ResolvedTraceScrub {
  return {
    sensitive: spec?.scrub?.sensitive ?? true,
    injection: spec?.scrub?.injection ?? true,
    canary: spec?.scrub?.canary ?? true,
  };
}

function clampSampleRate(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isFinite(value)) {
    throw new TheorumError('observability.sampleRate must be a finite number');
  }
  if (value < 0 || value > 1) {
    throw new TheorumError('observability.sampleRate must be between 0 and 1 inclusive');
  }
  return value;
}

/**
 * Apply defaults to a profile's observability block.
 *
 * Omitted block → record false (noop). Explicit `writeTo: false` → record false.
 * A writeTo target with sampleRate 0 still resolves record false at write time.
 */
function resolveObservabilityPolicy(
  spec: ProfileObservabilitySpec | undefined,
): ResolvedObservabilityPolicy {
  const writeTo = spec?.writeTo;
  const sampleRate = clampSampleRate(spec?.sampleRate);
  const record = spec !== undefined && writeTo !== false && writeTo !== undefined;
  return {
    record,
    writeTo,
    sampleRate,
    include: resolveInclude(spec),
    scrub: resolveScrub(spec),
    retainForDays: spec?.retainForDays ?? DEFAULT_RETAIN_DAYS,
    rotateAfterMiB: spec?.rotateAfterMiB ?? DEFAULT_ROTATE_MIB,
    onWriteError: spec?.onWriteError,
  };
}

function bindOnWriteError(sink: TraceSink, onWriteError?: (err: unknown) => void): TraceSink {
  if (!onWriteError && !sink.onError) {
    return sink;
  }
  return {
    write: (record) => sink.write(record),
    onError: sink.onError ?? onWriteError,
  };
}

function withSampleRate(sink: TraceSink, sampleRate: number, random: () => number): TraceSink {
  if (sampleRate >= 1) {
    return sink;
  }
  if (sampleRate <= 0) {
    return noopSink();
  }
  return {
    write: async (record) => {
      if (random() < sampleRate) {
        await sink.write(record);
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
      jsonlSink(destination.dir, {
        retainForDays: policy.retainForDays,
        rotateAfterMiB: policy.rotateAfterMiB,
      }),
      policy.onWriteError,
    );
  }
  if (!isTraceSink(destination)) {
    throw new TheorumError(`Trace destination '${writeTo}' is not a usable writer`);
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
  /** Injectable for deterministic sampleRate tests. */
  random?: () => number;
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
    sink: withSampleRate(
      sinkFromWriteTo(policy.writeTo, policy),
      policy.sampleRate,
      args.random ?? Math.random,
    ),
  };
}

export { resolveObservabilityPolicy, resolveTraceWriter };
