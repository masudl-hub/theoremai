import { TheoremError } from '../../guardrails/error.ts';
import { assertProviderRequirements } from '../provider-runtime.ts';
import type { ModelId } from '../types.ts';
import { profileInputs, requireModelBinding } from './catalog.ts';
import type { KernelRegistry } from './kernel-registry.ts';
import { providerCompleteRequest } from './provider-request.ts';
import { isModelProfile, resolveTurnInRegistry } from './resolve.ts';

/** A model of a profile that cannot run a plain turn on its provider, and the kernel's words for why. */
export interface TurnShortfall {
  model: ModelId;
  message: string;
}

/** The profile types whose turns the provider check runs on. Live and decision check their own. */
const CHECKED = new Set(['text', 'image', 'speech']);

/**
 * Each model of profile `id` that cannot run a plain turn on its provider: the check the provider
 * makes as a turn starts, made before one. A plain turn is one line of text at the model's default
 * effort, with the profile's tools. An effort a turn selects is checked when that turn runs.
 */
export function turnShortfallsInRegistry(registry: KernelRegistry, id: string): TurnShortfall[] {
  const profile = registry.profiles.find(id);
  if (!profile || !isModelProfile(profile) || !CHECKED.has(profile.type)) return [];
  const text = profileInputs(profile)?.text === false ? undefined : 'Hello.';
  return Object.keys(profile.models).flatMap((model) => {
    try {
      const { generation } = resolveTurnInRegistry(
        registry,
        { profile: id, input: { text } },
        model,
      );
      const binding = requireModelBinding(profile, model);
      const provider = registry.providers.require(binding.provider);
      assertProviderRequirements(
        provider,
        binding,
        profile.type,
        providerCompleteRequest(registry.tools, generation, ''),
      );
      return [];
    } catch (error) {
      // why: only a provider's refusal is a shortfall; any other error is not about the provider.
      return error instanceof TheoremError && error.kind === 'unsupported'
        ? [{ model, message: error.message }]
        : [];
    }
  });
}
