import { TheoremError } from '../guardrails/error.ts';
import { labelText } from '../guardrails/labels.ts';
import type { ProviderHostOptions } from './protocols/runtime.ts';
import { assertHistoryKept, registeredTurnModel } from './provider-runtime.ts';
import type { KernelRegistry } from './registry/kernel-registry.ts';
import type { ModelBinding, TurnModel, TurnRequest } from './types.ts';

export interface RegistryTurnModel extends TurnModel {
  forProfile(profileId: string, modelId?: string, request?: TurnRequest): RegistryTurnModel;
}
export function resolveRegisteredTurnModel(
  registry: KernelRegistry,
  profileId: string,
  modelId: string | undefined,
  options: ProviderHostOptions,
  request?: TurnRequest,
): RegistryTurnModel {
  const profile = registry.profiles.get(profileId);
  if (profile.type === 'host') return hostAgentModel(registry, options);
  if (profile.type === 'decision' || profile.type === 'live' || profile.type === 'embedding')
    throw new TheoremError('unsupported', labelText('provider.turn_profile'));
  const binding: ModelBinding | undefined = profile.models[modelId ?? profile.defaultModel];
  if (!binding) throw new TheoremError('config', labelText('provider.model_binding_missing'));
  assertHistoryKept(profile.providerContinuation, request?.providerState, request?.input?.history);
  const turn = registeredTurnModel(
    registry.providers.require(binding.provider, binding.apiId),
    structuredClone(binding),
    profile.type,
    options,
    request?.providerState,
    profile.providerContinuation,
    request?.input?.history,
  );
  return {
    complete: turn.complete,
    forProfile: (id, model, req) => resolveRegisteredTurnModel(registry, id, model, options, req),
  };
}
/**
 * A host's provider options as the model of the agents its call runs. It
 * completes nothing itself: a host's own call and a live session run no turn.
 */
export function hostAgentModel(
  registry: KernelRegistry,
  options: ProviderHostOptions,
): RegistryTurnModel {
  return {
    complete() {
      throw new TheoremError('unsupported', labelText('provider.host_model'));
    },
    forProfile: (id, model, req) => resolveRegisteredTurnModel(registry, id, model, options, req),
  };
}
export function nestedTurnModel(
  provider: TurnModel,
  profileId: string,
  modelId?: string,
  request?: TurnRequest,
): TurnModel {
  return 'forProfile' in provider && typeof provider.forProfile === 'function'
    ? provider.forProfile(profileId, modelId, request)
    : provider;
}
