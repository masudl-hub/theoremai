import { type Boundary, recordOf } from '../../src/guardrails/boundaries.ts';
import {
  boundaryReader,
  type Detection,
  type DetectScope,
  detectAt,
  redactDetectors,
  scopeOf,
} from '../../src/guardrails/detect-at.ts';
import {
  DETECTORS,
  type Detector,
  type DetectorRule,
  type DetectSpec,
  NO_ALLOW,
  resolveDetect,
} from '../../src/guardrails/detectors.ts';
import {
  createEgressStream,
  type EgressStream,
  type EgressStreamOptions,
} from '../../src/guardrails/egress-stream.ts';
import type { GuardrailHit } from '../../src/guardrails/event-schemas.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
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

/**
 * The detectors a reply is read by in the scanner tests: every one but `network`, which names no
 * secret, and `ungiven_links`, which a profile leaves at `ignore` unless it sets it.
 */
export const REPLY_DETECTORS: readonly Detector[] = DETECTORS.filter(
  (detector) => detector !== 'network' && detector !== 'ungiven_links',
);

/** A matrix with `detectors` set to `block` at `reply` and every other detector off there. */
function blockingAtReply(detectors: readonly Detector[]): DetectSpec {
  return recordOf(
    DETECTORS,
    (detector): DetectorRule => ({
      at: { reply: detectors.includes(detector) ? 'block' : 'ignore' },
    }),
  );
}

/** Everything that stops `text` as a reply in a turn of `scope`: each match of `detectors`. */
export function replyHits(
  text: string,
  scope: DetectScope = {},
  detectors: readonly Detector[] = REPLY_DETECTORS,
): GuardrailHit[] {
  return detectAt(text, 'reply', resolveDetect(blockingAtReply(detectors)), scope).hits;
}

/** The stream scanner reading a reply for `detectors`. */
export function replyStream(
  options: EgressStreamOptions = {},
  detectors: readonly Detector[] = REPLY_DETECTORS,
): EgressStream {
  return createEgressStream({ detect: detectors, ...options });
}

/**
 * A `guardrails.detect` with one detector of the host's own, `test.term`, which blocks a reply's
 * text that names `term`.
 */
/** The hint a retry carries after {@linkcode blockNaming} blocked a reply. */
export const TERM_HINT = lexiconDefault('detect.hint.own', { label: 'Test term' });

export function blockNaming(term: string): DetectSpec {
  return {
    'test.term': {
      label: 'Test term',
      at: { reply: 'block' },
      find: (text) => {
        const start = text.indexOf(term);
        return start < 0 ? [] : [{ start, end: start + term.length }];
      },
    },
  };
}

/** The stream gate with `detectors` set to `block` at `reply`. */
export function replyGate(
  context: GuardrailContext,
  detectors: readonly Detector[] = REPLY_DETECTORS,
): ProgressiveYieldGate {
  const matrix = resolveDetect(blockingAtReply(detectors));
  return createProgressiveYieldGate({
    context,
    detect: {
      matrix,
      boundary: 'reply',
      rewrite: true,
      scope: scopeOf({ detect: matrix, allow: NO_ALLOW }, context),
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
