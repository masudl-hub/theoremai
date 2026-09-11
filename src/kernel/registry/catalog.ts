/**
 * MIME helpers and model binding utilities.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { MEDIA_INPUT_KINDS } from '../schema.ts';
import type {
  MediaInputKind,
  ModelBinding,
  ModelId,
  ModelProfile,
  ThinkingLevel,
} from '../types.ts';

function mimeEssence(mime: string): string {
  const [base] = mime.split(';');
  return (base ?? '').trim().toLowerCase();
}

function mimeAllowed(accept: string[], mime: string): boolean {
  const actual = mimeEssence(mime);
  return accept.some((rule) => {
    const allowed = mimeEssence(rule);
    if (allowed.endsWith('/*')) {
      return actual.startsWith(allowed.slice(0, -1));
    }
    return allowed === actual;
  });
}

function mediaKindForMime(mime: string): MediaInputKind | undefined {
  return MEDIA_INPUT_KINDS[mimeEssence(mime)];
}

/** Require a host-declared model binding for a profile model id. */
function requireModelBinding(profile: ModelProfile, modelId: ModelId): ModelBinding {
  const binding = profile.models[modelId];
  if (!binding) {
    throw new TheorumError(`Profile ${profile.id} has no model binding for '${modelId}'`);
  }
  return binding;
}

function effortLevels(binding: ModelBinding | undefined): ThinkingLevel[] {
  if (!binding?.efforts) {
    return [];
  }
  return Object.values(binding.efforts);
}

function clampLevels(binding: ModelBinding | undefined, level: ThinkingLevel): ThinkingLevel {
  const legal = effortLevels(binding);
  if (legal.length === 0) {
    return level;
  }
  if (legal.includes(level)) {
    return level;
  }
  const fallbackAlias = binding?.defaultEffort;
  const fallback = fallbackAlias ? binding?.efforts?.[fallbackAlias] : undefined;
  if (fallback && legal.includes(fallback)) {
    return fallback;
  }
  return legal[0] ?? level;
}

/** Clamp a requested thinking level to what the model binding accepts. */
function clampThinkingLevel(binding: ModelBinding, level: ThinkingLevel): ThinkingLevel {
  return clampLevels(binding, level);
}

/** Look up a model binding by provider-native API id within a host map. */
function modelEntryByApiId(
  bindings: Record<string, ModelBinding>,
  apiId: string,
): ModelBinding | undefined {
  return Object.values(bindings).find((m) => m.apiId === apiId);
}

/** Clamp thinking level using a provider-native API id within a host map. */
function clampThinkingLevelForApiId(
  bindings: Record<string, ModelBinding>,
  apiId: string,
  level: ThinkingLevel,
): ThinkingLevel {
  return clampLevels(modelEntryByApiId(bindings, apiId), level);
}

export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelBinding,
};
