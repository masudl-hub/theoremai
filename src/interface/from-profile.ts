// why: `profileInterfaceSchema` keeps only the JSON it names, so host functions never reach the view.

import { egressChecksOf, type ResolvedEgressChecks, type UrlCheck } from '../guardrails/egress.ts';
import { clientLexicon } from '../guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../guardrails/policy.ts';
import type { ProfileGuardrailsSpec } from '../guardrails/types.ts';
import { projectProfileObject, requireModelProfile } from '../kernel/registry/resolve.ts';
import { profileAllowsSteering } from '../kernel/stop.ts';
import type { ToolRegistry } from '../kernel/tools/registry.ts';
import { profileToolAllow, profileToolsSpec } from '../kernel/tools/resolve.ts';
import type { LiveProfile, ModelProfile, Profile, ProjectedProfile } from '../kernel/types.ts';
import { resolveObservabilityPolicy } from '../observability/resolve-policy.ts';
import type { ProfileObservabilitySpec } from '../observability/types.ts';
import { inputsFromSpec } from './inputs.ts';
import { profileInterfaceSchema } from './profile-interface.ts';
import type {
  ComposerProfileInterface,
  EgressChecksView,
  LiveProfileInterface,
  ProfileGuardrailsView,
  ProfileInterface,
  ProfileObservabilityView,
  ProfileToolsView,
  UrlCheckView,
} from './types.ts';

/** Resolved, not raw: a host sees what the kernel will enforce, not defaults of its own. */
function guardrailsView(guardrails?: ProfileGuardrailsSpec): ProfileGuardrailsView {
  const policy = resolveGuardrailPolicy(guardrails);
  return {
    quota: policy.quota,
    canary: policy.canary,
    detect: policy.detect,
    hasEgress: Boolean(policy.egress),
    egressChecks: egressChecksView(egressChecksOf(policy.egress?.enforce)),
  };
}

function urlCheckView(check: UrlCheck | undefined): UrlCheckView {
  return check ? { hosts: [...(check.hosts ?? [])], fromTools: check.fromTools ?? true } : false;
}

function egressChecksView(checks: ResolvedEgressChecks | undefined): EgressChecksView | null {
  if (!checks) return null;
  return {
    boundary: checks.boundary,
    images: urlCheckView(checks.images),
    links: urlCheckView(checks.links),
  };
}

function writeToView(
  writeTo: ProfileObservabilitySpec['writeTo'],
): ProfileObservabilityView['writeTo'] {
  if (writeTo === undefined || writeTo === false) {
    return writeTo;
  }
  if (typeof writeTo === 'string') {
    return writeTo;
  }
  return 'custom';
}

/** `writeTo` becomes `'custom'` when it is an inline TraceSink. */
function observabilityView(
  observability?: ProfileObservabilitySpec,
): ProfileObservabilityView | undefined {
  if (!observability) {
    return undefined;
  }
  const policy = resolveObservabilityPolicy(observability);
  return {
    record: policy.record,
    writeTo: writeToView(policy.writeTo),
    sampleRate: policy.sampleRate,
    include: policy.include,
    scrub: policy.scrub,
    resource: policy.resource,
    retainForDays: policy.retainForDays,
    rotateAfterMiB: policy.rotateAfterMiB,
    hasOnWriteError: Boolean(policy.onWriteError),
  };
}

function toolsView(projected: ProjectedProfile, profile?: ModelProfile): ProfileToolsView {
  if (profile) {
    const t2Loader = profileToolsSpec(profile)?.t2Loader;
    return { allow: [...profileToolAllow(profile)], ...(t2Loader ? { t2Loader } : {}) };
  }
  const allow = projected.tools
    .filter((tool) => !('type' in tool && tool.type === 'builtin'))
    .map((tool) => tool.name);
  return { allow };
}

function enrich(projected: ProjectedProfile, profile?: ModelProfile): ProfileInterface {
  const inputs = inputsFromSpec(projected.inputs);
  const identity = profile?.identity ?? { handle: projected.handle };
  const guardrails = profile ? guardrailsView(profile.guardrails) : undefined;
  const observability = profile ? observabilityView(profile.observability) : undefined;
  const outputs = projected.outputs ?? undefined;
  const shared = {
    id: projected.id,
    identity,
    models: projected.models,
    defaultModel: projected.defaultModel,
    allowModelSelect: projected.allowModelSelect,
    maxSteps: projected.maxSteps,
    key: projected.key,
    outputs,
    guardrails,
    observability,
    lexicon: clientLexicon(profile?.lexicon),
  };

  switch (projected.type) {
    case 'text':
      return profileInterfaceSchema.parse({
        ...shared,
        type: 'text',
        inputs,
        tools: toolsView(projected, profile),
        turnBehaviour: profile?.type === 'text' ? profile.turnBehaviour : undefined,
        canStop: true,
        allowSteering: profile ? profileAllowsSteering(profile) : true,
      });
    case 'image':
      return profileInterfaceSchema.parse({
        ...shared,
        type: 'image',
        image: projected.image ?? {},
        inputs,
        tools: toolsView(projected, profile),
        turnBehaviour: profile?.type === 'image' ? profile.turnBehaviour : undefined,
        canStop: true,
      });
    case 'speech':
      return profileInterfaceSchema.parse({
        ...shared,
        type: 'speech',
        speech: projected.speech ?? {},
        inputs,
        turnBehaviour: profile?.type === 'speech' ? profile.turnBehaviour : undefined,
        canStop: true,
      });
    case 'live':
      return profileInterfaceSchema.parse({
        ...shared,
        type: 'live',
        live: projected.live ?? {},
        tools: { allow: toolsView(projected, profile).allow },
      });
    default: {
      const exhaustive: never = projected.type;
      return exhaustive;
    }
  }
}

/**
 * The interface for `input`, its tools resolved from `tools`: the registry of
 * the scope that runs the profile.
 */
function interfaceFromProfile(input: LiveProfile, tools: ToolRegistry): LiveProfileInterface;
/** The interface for a profile that is not live. */
function interfaceFromProfile(
  input: Exclude<Profile, LiveProfile>,
  tools: ToolRegistry,
): ComposerProfileInterface;
/** The interface for any profile. */
function interfaceFromProfile(input: Profile, tools: ToolRegistry): ProfileInterface;
/** The interface for any profile. */
function interfaceFromProfile(input: Profile, tools: ToolRegistry): ProfileInterface {
  // why: Host profiles never run a model and have no composer surface.
  const profile = requireModelProfile(input, 'interfaceFromProfile');
  return enrich(projectProfileObject(tools, profile), profile);
}

/** The interface for a profile the host has already projected, without resolving its tools again. */
function interfaceFromProjected(projected: ProjectedProfile): ProfileInterface {
  return enrich(projected);
}

export { interfaceFromProfile, interfaceFromProjected };
