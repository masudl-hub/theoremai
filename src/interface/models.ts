/**
 * Profile model selection for composer hosts.
 *
 * @module
 */

import type { ModelBinding, ModelId } from '../kernel/types.ts';
import type { ComposerProfileInterface } from './types.ts';

type ModelSelectProfile = Pick<
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

/** True when the host should render a model picker before sending turns. */
function modelSelectEnabled(profile: ModelSelectProfile): boolean {
  return Boolean(profile.allowModelSelect && Object.keys(profile.models).length >= 2);
}

/** True when the selected model exposes two or more effort aliases. */
function effortSelectEnabled(profile: ModelSelectProfile, modelId: ModelId | undefined): boolean {
  const binding = bindingFor(profile, modelId);
  if (!binding?.allowEffortSelect) return false;
  return Object.keys(binding.efforts ?? {}).length >= 2;
}

/** Show generation controls when model or effort can be chosen at turn time. */
function generationSelectEnabled(
  profile: ModelSelectProfile,
  modelId: ModelId | undefined,
): boolean {
  return modelSelectEnabled(profile) || effortSelectEnabled(profile, modelId);
}

/** Initial selection — `defaultModel`, else the sole declared model id. */
function defaultInterfaceModel(profile: ModelSelectProfile): ModelId | undefined {
  if (profile.defaultModel && profile.models[profile.defaultModel]) {
    return profile.defaultModel;
  }
  const ids = Object.keys(profile.models);
  return ids.length === 1 ? ids[0] : ids[0];
}

/** Default effort alias for a model binding. */
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

/** Selectable models for the composer UI (empty when selection is disabled). */
function interfaceModelOptions(profile: ModelSelectProfile): InterfaceModelOption[] {
  if (!modelSelectEnabled(profile)) return [];
  return Object.entries(profile.models).map(([id, binding]) => ({
    id,
    label: binding.apiId,
  }));
}

/** Effort aliases for the selected model (empty when effort selection is disabled). */
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
  defaultInterfaceModel,
  effortSelectEnabled,
  generationSelectEnabled,
  interfaceEffortOptions,
  interfaceModelOptions,
  modelSelectEnabled,
};
