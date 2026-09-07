/**
 * MIME helpers and model spec utilities.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import { MEDIA_INPUT_KINDS } from '../schema.ts';
import type { MediaInputKind, ModelId, ModelSpec, Profile, ThinkingLevel } from '../types.ts';

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

/** Require a host-declared model spec for an allowed profile model id. */
function requireModelSpec(profile: Profile, modelId: ModelId): ModelSpec {
  const spec = profile.model.config[modelId];
  if (!spec) {
    throw new TheorumError(`Profile ${profile.id} has no model spec for '${modelId}'`);
  }
  return spec;
}

function clampLevels(entry: ModelSpec | undefined, level: ThinkingLevel): ThinkingLevel {
  if (!entry?.thinkingLevels || entry.thinkingLevels.length === 0) {
    return level;
  }
  if (entry.thinkingLevels.includes(level)) {
    return level;
  }
  const fallback = entry.thinking?.off;
  if (fallback && entry.thinkingLevels.includes(fallback)) {
    return fallback;
  }
  const first = entry.thinkingLevels[0];
  return first ?? level;
}

/** Clamp a requested thinking level to what the model spec accepts. */
function clampThinkingLevel(spec: ModelSpec, level: ThinkingLevel): ThinkingLevel {
  return clampLevels(spec, level);
}

/** Look up a model spec by provider-native API id within a host specs map. */
function modelEntryByApiId(specs: Record<string, ModelSpec>, apiId: string): ModelSpec | undefined {
  return Object.values(specs).find((m) => m.apiId === apiId);
}

/** Clamp thinking level using a provider-native API id within a host specs map. */
function clampThinkingLevelForApiId(
  specs: Record<string, ModelSpec>,
  apiId: string,
  level: ThinkingLevel,
): ThinkingLevel {
  return clampLevels(modelEntryByApiId(specs, apiId), level);
}

export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelSpec,
};
