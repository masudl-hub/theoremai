import { TheoremError } from '../guardrails/error.ts';
import { lexiconText } from '../guardrails/lexicon.ts';
import type { ProviderHostOptions } from './provider-contract.ts';
import {
  assertHistoryKept,
  registeredTurnProvider,
  snapshotRegisteredProvider,
} from './provider-runtime.ts';
import type { KernelRegistry } from './registry/kernel-registry.ts';
import type { ModelBinding, ModelProvider, TurnRequest } from './types.ts';

export interface RegistryModelProvider extends ModelProvider {
  forProfile(profileId: string, modelId?: string, request?: TurnRequest): RegistryModelProvider;
}
export function resolveRegisteredTurnProvider(
  registry: KernelRegistry,
  profileId: string,
  modelId: string | undefined,
  options: ProviderHostOptions,
  request?: TurnRequest,
): RegistryModelProvider {
  const profile = registry.profiles.get(profileId);
  if (profile.type === 'host') return hostAgentProvider(registry, options);
  if (profile.type === 'decision' || profile.type === 'live')
    throw new TheoremError('unsupported', lexiconText('provider.turn_profile'));
  const binding: ModelBinding | undefined = profile.models[modelId ?? profile.defaultModel];
  if (!binding) throw new TheoremError('config', lexiconText('provider.model_binding_missing'));
  assertHistoryKept(profile.providerContinuation, request?.providerState, request?.input?.history);
  const selected = registry.providers.require(binding.provider);
  const provider = snapshotRegisteredProvider(selected);
  const turn = registeredTurnProvider(
    provider,
    { ...binding, providerOptions: structuredClone(binding.providerOptions ?? {}) },
    profile.type,
    options,
    request?.providerState,
    profile.providerContinuation,
    request?.input?.history,
  );
  return {
    complete: turn.complete,
    forProfile: (id, model, req) =>
      resolveRegisteredTurnProvider(registry, id, model, options, req),
  };
}
/**
 * A host's provider options as the provider of the agents its call runs. It
 * completes nothing itself: a host's own call and a live session run no turn.
 */
export function hostAgentProvider(
  registry: KernelRegistry,
  options: ProviderHostOptions,
): RegistryModelProvider {
  return {
    complete() {
      throw new TheoremError('unsupported', lexiconText('provider.host_model'));
    },
    forProfile: (id, model, req) =>
      resolveRegisteredTurnProvider(registry, id, model, options, req),
  };
}
export function nestedRegisteredProvider(
  provider: ModelProvider,
  profileId: string,
  modelId?: string,
  request?: TurnRequest,
): ModelProvider {
  return 'forProfile' in provider && typeof provider.forProfile === 'function'
    ? provider.forProfile(profileId, modelId, request)
    : provider;
}
