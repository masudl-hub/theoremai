import type { ModelBinding, ModelId } from '../kernel/types.ts';
import type { ComposerProfileInterface } from './types.ts';

export type ModelSelectProfile = Pick<
  ComposerProfileInterface,
  'id' | 'models' | 'defaultModel' | 'allowModelSelect'
>;

/** One model a user can pick from. */
export type InterfaceModelOption = {
  id: ModelId;
  label: string;
};

/** One effort level a user can pick from, by alias. */
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

/** True when the profile lets the user pick between two or more models. */
function modelSelectEnabled(profile: ModelSelectProfile): boolean {
  return Boolean(profile.allowModelSelect && Object.keys(profile.models).length >= 2);
}

/** True when the model lets the user pick between two or more effort levels. */
function effortSelectEnabled(profile: ModelSelectProfile, modelId: ModelId | undefined): boolean {
  const binding = bindingFor(profile, modelId);
  if (!binding?.allowEffortSelect) return false;
  return Object.keys(binding.efforts ?? {}).length >= 2;
}

/** True when the user has any model or effort choice to make. */
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

/** The models the user can pick from, or none when the choice is off. */
function interfaceModelOptions(profile: ModelSelectProfile): InterfaceModelOption[] {
  if (!modelSelectEnabled(profile)) return [];
  return Object.entries(profile.models).map(([id, binding]) => ({
    id,
    label: binding.apiId,
  }));
}

/** The effort levels the user can pick from for this model, or none when the choice is off. */
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
