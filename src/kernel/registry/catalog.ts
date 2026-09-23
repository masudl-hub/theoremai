/**
 * MIME helpers and model binding utilities.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import { MEDIA_INPUT_KINDS } from '../schema.ts';
import type {
  MediaInputKind,
  ModelBinding,
  ModelId,
  ModelProfile,
  Profile,
  ProfileInputsSpec,
  ThinkingLevel,
} from '../types.ts';
import { mimeEssence } from '../util/mime.ts';

/** `TurnInput` field a media file rides in. */
type MediaInputChannel = 'attachments' | 'voice';

/**
 * Returns whether an accept list permits a MIME value. Rules are normalized and
 * support a subtype wildcard such as `image/*`; parameter values are ignored.
 */
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

/** Maps a normalized MIME value to a kernel-supported media input kind, if any. */
function mediaKindForMime(mime: string): MediaInputKind | undefined {
  return MEDIA_INPUT_KINDS[mimeEssence(mime)];
}

/** The turn inputs spec; only `text` and `image` declare one. */
function profileInputs(profile: Profile): ProfileInputsSpec | undefined {
  return profile.type === 'text' || profile.type === 'image' ? profile.inputs : undefined;
}

/** The `accept` list a profile declares for one input channel, if it declares one. */
function profileAccept(profile: Profile, channel: MediaInputChannel): string[] | undefined {
  const inputs = profileInputs(profile);
  return channel === 'voice' ? inputs?.voice?.accept : inputs?.attachments?.accept;
}

/**
 * Which `TurnInput` channel of a profile accepts this MIME, or `undefined` when
 * the profile accepts it nowhere (or the kernel cannot classify it at all).
 *
 * The one public answer to "does this profile take this file". Hosts route and
 * filter channel ingress with it instead of keeping their own MIME table: the
 * profile's `accept` lists are the whole declaration.
 */
function mediaChannelForMime(profile: Profile, mime: string): MediaInputChannel | undefined {
  if (!mediaKindForMime(mime)) {
    return undefined;
  }
  for (const channel of ['attachments', 'voice'] as const) {
    const accept = profileAccept(profile, channel);
    if (accept && mimeAllowed(accept, mime)) {
      return channel;
    }
  }
  return undefined;
}

/** Require a host-declared model binding for a profile model id. */
function requireModelBinding(profile: ModelProfile, modelId: ModelId): ModelBinding {
  const binding = profile.models[modelId];
  if (!binding) {
    throw new TheoremError(`Profile ${profile.id} has no model binding for '${modelId}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

export type { MediaInputChannel };
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaChannelForMime,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  profileAccept,
  profileInputs,
  requireModelBinding,
};
