/**
 * Guardrail policy resolution — one place where profile switches become defaults.
 *
 * Every ingress and egress path resolves through here so the turn engine and Live
 * ingress cannot drift apart on what "unset" means.
 *
 * @module
 */

import type { ProfileGuardrailsSpec, ResolvedGuardrailPolicy, TrustLevel } from './types.ts';

/** Detection switches for one piece of text, after trust is taken into account. */
export interface DetectionOptions {
  sanitizeInput: boolean;
  redactSensitive: boolean;
}

/**
 * Apply kernel defaults to a profile's guardrail switches.
 *
 * Sanitization, sensitive redaction, and canary default on. Set `canary: false`
 * to opt out of minting a per-turn token into the system prompt.
 */
function resolveGuardrailPolicy(spec: ProfileGuardrailsSpec | undefined): ResolvedGuardrailPolicy {
  return {
    sanitizeInput: spec?.sanitizeInput ?? true,
    redactSensitive: spec?.redactSensitive ?? true,
    canary: spec?.canary ?? true,
    egress: spec?.egress,
    network: spec?.network,
    quota: spec?.quota,
    taint: spec?.taint,
  };
}

/**
 * Narrow a resolved policy to the detectors that may run against text of a given
 * origin, on the way to the provider.
 *
 * Trusted text is author-time profile copy. Injection redaction would strip the
 * host's own anti-injection instructions, and sensitive redaction would rewrite a
 * prompt that legitimately shows a key or address format — so trusted text is
 * passed to the provider verbatim. Trace safety does not depend on this: the trace
 * writer redacts independently on every path.
 *
 * Assembled and untrusted text take whatever the profile enabled.
 */
function detectionForTrust(policy: ResolvedGuardrailPolicy, trust: TrustLevel): DetectionOptions {
  if (trust === 'trusted') {
    return { sanitizeInput: false, redactSensitive: false };
  }
  return {
    sanitizeInput: policy.sanitizeInput,
    redactSensitive: policy.redactSensitive,
  };
}

export { detectionForTrust, resolveGuardrailPolicy };
