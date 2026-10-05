import type { Boundary } from '../../src/guardrails/boundaries.ts';
import {
  boundaryReader,
  type Detection,
  detectAt,
  redactDetectors,
} from '../../src/guardrails/detect-at.ts';
import {
  DETECTORS,
  type Detector,
  type DetectSpec,
  resolveDetect,
} from '../../src/guardrails/detectors.ts';
import {
  collectEgressHits,
  DEFAULT_CHECKS,
  type EgressScope,
  type ResolvedEgressChecks,
  standardEgressEnforce,
} from '../../src/guardrails/egress.ts';
import {
  createEgressStream,
  type EgressStream,
  type EgressStreamOptions,
} from '../../src/guardrails/egress-stream.ts';
import type { GuardrailHit } from '../../src/guardrails/event-schemas.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import {
  createProgressiveYieldGate,
  type ProgressiveYieldGate,
} from '../../src/guardrails/progressive-yield.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { sanitizeTurnBlobs } from '../../src/kernel/registry/attachments.ts';
import type { Profile } from '../../src/kernel/types.ts';

/** `text` with every detector's matches replaced by its placeholder. */
export function redactAll(text: string): string {
  return redactDetectors(text, DETECTORS);
}

/** `text` read as it crosses `boundary` under a `guardrails.detect` setting. */
export function readAt(text: string, boundary: Boundary, detect?: DetectSpec): Detection {
  return detectAt(text, boundary, resolveDetect(detect));
}

/** The detectors a reply is read by in the scanner tests: every one but `network`, which names no secret. */
export const REPLY_DETECTORS: readonly Detector[] = DETECTORS.filter(
  (detector) => detector !== 'network',
);

/** A matrix with `detectors` set to `block` at `reply` and every other detector off there. */
function blockingAtReply(detectors: readonly Detector[]): DetectSpec {
  return Object.fromEntries(
    DETECTORS.map((detector) => [
      detector,
      { reply: detectors.includes(detector) ? 'block' : 'ignore' },
    ]),
  );
}

/** Everything that stops `text` as a reply: the bundled policy's hits, and each match of `detectors`. */
export function replyHits(
  text: string,
  scope: EgressScope = {},
  checks: ResolvedEgressChecks = DEFAULT_CHECKS,
  detectors: readonly Detector[] = REPLY_DETECTORS,
): GuardrailHit[] {
  return [
    ...collectEgressHits(text, scope, checks),
    ...readAt(text, 'reply', blockingAtReply(detectors)).hits,
  ];
}

/** The stream scanner reading a reply for the bundled policy and `detectors`. */
export function replyStream(
  options: EgressStreamOptions = {},
  detectors: readonly Detector[] = REPLY_DETECTORS,
): EgressStream {
  return createEgressStream({ detect: detectors, ...options });
}

/** The stream gate under the bundled policy, with `detectors` set to `block` at `reply`. */
export function replyGate(
  context: GuardrailContext,
  detectors: readonly Detector[] = REPLY_DETECTORS,
): ProgressiveYieldGate {
  return createProgressiveYieldGate({
    context,
    enforce: standardEgressEnforce,
    detect: {
      matrix: resolveDetect(blockingAtReply(detectors)),
      boundary: 'reply',
      rewrite: true,
    },
  });
}

/** `sanitizeTurnBlobs` with a reader for each blob boundary, under the profile's own guardrails. */
export function sanitizeBlobs(
  profile: Profile,
  attachments: Parameters<typeof sanitizeTurnBlobs>[1],
  voice: Parameters<typeof sanitizeTurnBlobs>[2],
): ReturnType<typeof sanitizeTurnBlobs> {
  const { detect } = resolveGuardrailPolicy(profile.guardrails);
  return sanitizeTurnBlobs(profile, attachments, voice, {
    attachment: boundaryReader('attachment', detect),
    voice: boundaryReader('voice', detect),
  });
}
