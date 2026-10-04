import type { ModelBinding, ModelId } from '../kernel/types.ts';
import type { ComposerProfileInterface } from './types.ts';

export type ModelSelectProfile = Pick<
  ComposerProfileInterface,
  'id' | 'models' | 'defaultModel' | 'allowModelSelect'
>;

export type InterfaceModelOption = {
  id: ModelId;
  label: string;
};

export type InterfaceEffortOption = {
  alias: string;
  level: string;
};

function bindingFor(
  profile: ModelSelectProfile,
  modelId: ModelId | undefined,
): ModelBinding | undefined {
  if (!modelId) return undefined;
  return profile.models[modelId];
}

function modelSelectEnabled(profile: ModelSelectProfile): boolean {
  return Boolean(profile.allowModelSelect && Object.keys(profile.models).length >= 2);
}

function effortSelectEnabled(profile: ModelSelectProfile, modelId: ModelId | undefined): boolean {
  const binding = bindingFor(profile, modelId);
  if (!binding?.allowEffortSelect) return false;
  return Object.keys(binding.efforts ?? {}).length >= 2;
}

function generationSelectEnabled(
  profile: ModelSelectProfile,
  modelId: ModelId | undefined,
): boolean {
  return modelSelectEnabled(profile) || effortSelectEnabled(profile, modelId);
}

/** `defaultEffort` when it names an alias, else the first alias. */
function defaultInterfaceEffort(
  profile: ModelSelectProfile,
  modelId: ModelId | undefined,
): string | undefined {
  const binding = bindingFor(profile, modelId);
  if (!binding?.efforts) return undefined;
  const defaultAlias = binding.defaultEffort?.trim();
  if (defaultAlias && binding.efforts[defaultAlias]) return defaultAlias;
  const keys = Object.keys(binding.efforts);
  return keys[0];
}

function interfaceModelOptions(profile: ModelSelectProfile): InterfaceModelOption[] {
  if (!modelSelectEnabled(profile)) return [];
  return Object.entries(profile.models).map(([id, binding]) => ({
    id,
    label: binding.apiId,
  }));
}

function interfaceEffortOptions(
  profile: ModelSelectProfile,
  modelId: ModelId | undefined,
): InterfaceEffortOption[] {
  if (!effortSelectEnabled(profile, modelId)) return [];
  const binding = bindingFor(profile, modelId);
  if (!binding?.efforts) return [];
  return Object.entries(binding.efforts).map(([alias, level]) => ({ alias, level }));
}

export {
  defaultInterfaceEffort,
  effortSelectEnabled,
  generationSelectEnabled,
  interfaceEffortOptions,
  interfaceModelOptions,
  modelSelectEnabled,
};
