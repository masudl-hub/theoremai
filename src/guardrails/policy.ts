import { resolveDetect } from './detectors.ts';
import { egressPolicy } from './egress-policy.ts';
import type {
  EgressEnforcer,
  ProfileEgressSpec,
  ProfileGuardrailsSpec,
  ResolvedEgressSpec,
  ResolvedGuardrailPolicy,
} from './types.ts';

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

/** Every ingress and egress path resolves through here so none can drift on what "unset" means. */
function resolveGuardrailPolicy(spec: ProfileGuardrailsSpec | undefined): ResolvedGuardrailPolicy {
  const egress = resolveEgress(spec?.egress);
  return {
    detect: resolveDetect(spec?.detect),
    canary: spec?.canary ?? true,
    promptEcho: spec?.promptEcho ?? true,
    egress,
    network: spec?.network,
    quota: spec?.quota,
    taint: spec?.taint,
  };
}

export { resolveGuardrailPolicy };
