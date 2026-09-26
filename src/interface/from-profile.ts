/**
 * Profile → `ProfileInterface` projection.
 *
 * Kernel `projectProfileObject` is the single inspection projection; this module
 * enriches `inputs` (acceptAttr, an image profile's image cap), attaches
 * guardrails / observability views and the client's lexicon, and passes the
 * result through `profileInterfaceSchema`, which keeps only JSON the schema names.
 *
 * @module
 */

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
  LiveProfileInterface,
  ProfileGuardrailsView,
  ProfileInterface,
  ProfileObservabilityView,
  ProfileToolsView,
} from './types.ts';

/**
 * Project a profile's guardrails for the headless interface.
 *
 * Values are resolved, not raw: a host rendering this view sees what the kernel
 * will actually enforce rather than re-deriving defaults of its own.
 */
function guardrailsView(guardrails?: ProfileGuardrailsSpec): ProfileGuardrailsView {
  const policy = resolveGuardrailPolicy(guardrails);
  return {
    quota: policy.quota,
    canary: policy.canary,
    sanitizeInput: policy.sanitizeInput,
    redactSensitive: policy.redactSensitive,
    hasEgress: Boolean(policy.egress),
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

/**
 * Project a profile's observability for the headless interface.
 *
 * TraceSink and onWriteError are omitted; writeTo becomes 'custom' when inline.
 */
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
function interfaceFromProfile(
  input: Exclude<Profile, LiveProfile>,
  tools: ToolRegistry,
): ComposerProfileInterface;
function interfaceFromProfile(input: Profile, tools: ToolRegistry): ProfileInterface;
function interfaceFromProfile(input: Profile, tools: ToolRegistry): ProfileInterface {
  // Host profiles never run a model and have no composer surface.
  const profile = requireModelProfile(input, 'interfaceFromProfile');
  return enrich(projectProfileObject(tools, profile), profile);
}

function interfaceFromProjected(projected: ProjectedProfile): ProfileInterface {
  return enrich(projected);
}

export { interfaceFromProfile, interfaceFromProjected };
