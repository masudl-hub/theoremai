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
  Profile,
  ProfileGuardrailsSpec,
  ProfileModelSpec,
  ProjectedProfile,
} from '../kernel/types.ts';
import { inputsFromSpec } from './inputs.ts';
import type {
  NormalizeModel,
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

function normalizeModel<M extends ProfileModelSpec>(model: M): NormalizeModel<M> {
  return {
    ...model,
    select: model.select ?? null,
    controls: model.controls ?? [],
  };
}

function toolsResolved(projected: ProjectedProfile, profile?: Profile): ResolvedTools {
  if (projected.type === 'speech') {
    return { allow: [], resolved: [] };
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
  const model = normalizeModel(projected.model);
  const guardrails = profile ? guardrailsView(profile.guardrails) : undefined;
  const outputs = projected.outputs ?? undefined;
  const shared = { id: projected.id, identity, model, outputs, guardrails };

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
        inputs,
        tools: toolsResolved(projected, profile),
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

function interfaceFromProfile(profile: Profile): ProfileInterface {
  return interfaceFrom(profile);
}

function interfaceFromProjected(projected: ProjectedProfile): ProfileInterface {
  return interfaceFrom(projected);
}

export { interfaceFrom, interfaceFromProfile, interfaceFromProjected };
