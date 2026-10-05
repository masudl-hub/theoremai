import { BOUNDARIES, type Boundary, recordOf } from './boundaries.ts';
import {
  DETECT_DEFAULTS,
  DETECTORS,
  type DetectAction,
  type Detector,
  type ResolvedDetect,
  resolveDetect,
} from './detectors.ts';
import { egressChecksOf, type ResolvedEgressChecks } from './egress.ts';
import { egressPolicy } from './egress-policy.ts';
import { resolveSensitive, type SensitiveGroups, type SensitiveSelection } from './sensitive.ts';
import type {
  EgressEnforcer,
  ProfileEgressSpec,
  ProfileGuardrailsSpec,
  ResolvedEgressSpec,
  ResolvedGuardrailPolicy,
  TrustLevel,
} from './types.ts';

/** What input detection does: whether to sanitize input and which sensitive groups to redact. */
export interface DetectionOptions {
  sanitizeInput: boolean;
  redactSensitive: SensitiveSelection;
}

const NO_GROUPS: SensitiveGroups = resolveSensitive(false);

/** One enforce per spec, so the gates' per-enforce plans are built once. */
const BUNDLED = new WeakMap<ProfileEgressSpec, EgressEnforcer>();

function resolveEgress(spec: ProfileEgressSpec | undefined): ResolvedEgressSpec | undefined {
  if (!spec) return undefined;
  const { enforce, checks, ...rest } = spec;
  if (enforce) return { ...rest, enforce };
  let bundled = BUNDLED.get(spec);
  if (!bundled) {
    bundled = egressPolicy({ bundled: checks ?? true });
    BUNDLED.set(spec, bundled);
  }
  return { ...rest, enforce: bundled };
}

const REPLY_BOUNDARIES: ReadonlySet<Boundary> = new Set([
  'reply',
  'reply_structured',
  'live_reply',
]);

/** Whether the settings `detect` replaces have `detector` running, on text reaching the model and on the reply. */
interface LegacySwitch {
  inbound: boolean;
  reply: boolean;
}

function legacyAction(boundary: Boundary, byDefault: DetectAction, on: LegacySwitch): DetectAction {
  if (REPLY_BOUNDARIES.has(boundary)) return on.reply ? 'block' : byDefault;
  return on.inbound ? byDefault : 'ignore';
}

/**
 * The matrix the settings `detect` replaces amount to: `sanitizeInput` and
 * `redactSensitive` switch a detector off where its default reads text, and the
 * bundled reply checks block where they run.
 */
function legacyDetect(
  spec: ProfileGuardrailsSpec | undefined,
  checks: ResolvedEgressChecks | undefined,
): ResolvedDetect {
  const sensitive = resolveSensitive(spec?.redactSensitive);
  const switchOf = (detector: Detector): LegacySwitch =>
    detector === 'injection'
      ? { inbound: spec?.sanitizeInput ?? true, reply: checks?.injection ?? false }
      : { inbound: sensitive[detector], reply: checks?.sensitive[detector] ?? false };
  return recordOf(DETECTORS, (detector) => {
    const on = switchOf(detector);
    return recordOf(BOUNDARIES, (boundary) =>
      legacyAction(boundary, DETECT_DEFAULTS[detector][boundary], on),
    );
  });
}

/** Every ingress and egress path resolves through here so none can drift on what "unset" means. */
function resolveGuardrailPolicy(spec: ProfileGuardrailsSpec | undefined): ResolvedGuardrailPolicy {
  const egress = resolveEgress(spec?.egress);
  return {
    detect: resolveDetect(spec?.detect, legacyDetect(spec, egressChecksOf(egress?.enforce))),
    sanitizeInput: spec?.sanitizeInput ?? true,
    redactSensitive: resolveSensitive(spec?.redactSensitive),
    canary: spec?.canary ?? true,
    promptEcho: spec?.promptEcho ?? true,
    egress,
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
    return { sanitizeInput: false, redactSensitive: NO_GROUPS };
  }
  return {
    sanitizeInput: policy.sanitizeInput,
    redactSensitive: policy.redactSensitive,
  };
}

export { detectionForTrust, resolveGuardrailPolicy };
