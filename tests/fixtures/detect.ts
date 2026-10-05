import type { Boundary } from '../../src/guardrails/boundaries.ts';
import {
  boundaryReader,
  type Detection,
  detectAt,
  redactDetectors,
} from '../../src/guardrails/detect-at.ts';
import { DETECTORS, type DetectSpec, resolveDetect } from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
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
