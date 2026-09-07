/**
 * Profile → `ProfileInterface` projection.
 *
 * Kernel `projectProfileObject` is the single inspection projection; this module
 * only enriches `inputs` (acceptAttr) and attaches serializable guardrails.
 *
 * @module
 */

import { projectProfileObject } from '../kernel/registry/resolve.ts';
import type {
  LiveProfile,
  Profile,
  ProfileGuardrailsSpec,
  ProjectedProfile,
} from '../kernel/types.ts';
import { inputsFromSpec } from './inputs.ts';
import type {
  ComposerProfileInterface,
  LiveProfileInterface,
  LiveResolvedTools,
  ProfileGuardrailsView,
  ProfileInterface,
  ProfileInterfaceSource,
  ResolvedTools,
} from './types.ts';

function guardrailsView(guardrails?: ProfileGuardrailsSpec): ProfileGuardrailsView | undefined {
  if (!guardrails) return undefined;
  return {
    quota: guardrails.quota,
    canary: guardrails.canary,
    sanitizeInput: guardrails.sanitizeInput,
    redactSensitive: guardrails.redactSensitive,
    hasEgress: Boolean(guardrails.egress),
  };
}

function toolsResolved(projected: ProjectedProfile, profile?: Profile): ResolvedTools {
  if (projected.type === 'speech') {
    return { allow: [], resolved: [] };
  }
  if (profile?.type === 'live') {
    return {
      allow: profile.tools.allow,
      resolved: projected.tools,
    };
  }
  if (profile && profile.type !== 'speech') {
    return {
      allow: profile.tools.allow,
      t2Loader: profile.tools.t2Loader,
      resolved: projected.tools,
    };
  }
  const allow = projected.tools
    .filter((tool) => !('type' in tool && tool.type === 'builtin'))
    .map((tool) => tool.name);
  return { allow, resolved: projected.tools };
}

function enrich(projected: ProjectedProfile, profile?: Profile): ProfileInterface {
  const inputs = inputsFromSpec(projected.type, projected.inputs);
  const identity = profile?.identity ?? { handle: projected.handle };
  const guardrails = profile ? guardrailsView(profile.guardrails) : undefined;
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
  };

  switch (projected.type) {
    case 'text':
      return {
        ...shared,
        type: 'text',
        inputs,
        tools: toolsResolved(projected, profile),
        turnResumption: profile?.type === 'text' ? profile.turnResumption : undefined,
      } as ProfileInterface;
    case 'image':
      return {
        ...shared,
        type: 'image',
        image: projected.image ?? {},
        inputs,
        tools: toolsResolved(projected, profile),
        turnResumption: profile?.type === 'image' ? profile.turnResumption : undefined,
      } as ProfileInterface;
    case 'speech':
      return {
        ...shared,
        type: 'speech',
        speech: projected.speech ?? {},
        inputs,
        turnResumption: profile?.type === 'speech' ? profile.turnResumption : undefined,
      } as ProfileInterface;
    case 'live':
      return {
        ...shared,
        type: 'live',
        live: projected.live ?? {},
        tools: toolsResolved(projected, profile) as LiveResolvedTools,
      } as ProfileInterface;
    default: {
      const exhaustive: never = projected.type;
      return exhaustive;
    }
  }
}

function interfaceFrom(source: ProfileInterfaceSource): ProfileInterface {
  if ('identity' in source) {
    return enrich(projectProfileObject(source), source);
  }
  return enrich(source);
}

function interfaceFromProfile(profile: LiveProfile): LiveProfileInterface;
function interfaceFromProfile(profile: Exclude<Profile, LiveProfile>): ComposerProfileInterface;
function interfaceFromProfile(profile: Profile): ProfileInterface;
function interfaceFromProfile(profile: Profile): ProfileInterface {
  return interfaceFrom(profile);
}

function interfaceFromProjected(projected: ProjectedProfile): ProfileInterface {
  return interfaceFrom(projected);
}

export { interfaceFrom, interfaceFromProfile, interfaceFromProjected };
