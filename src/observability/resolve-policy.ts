/**
 * Observability policy resolution — profile switches become resolved defaults.
 *
 * Pure: no sinks, no file system. `policy.ts` builds the writer on top of this
 * so type consumers of the kernel never pull the JSONL sink into their graph.
 *
 * @module
 */

import { TheorumError } from '../guardrails/error.ts';
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
export function resolveObservabilityPolicy(
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
