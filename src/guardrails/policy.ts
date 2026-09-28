import type { ProfileGuardrailsSpec, ResolvedGuardrailPolicy, TrustLevel } from './types.ts';

export interface DetectionOptions {
  sanitizeInput: boolean;
  redactSensitive: boolean;
}

/** Every ingress and egress path resolves through here so none can drift on what "unset" means. */
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
