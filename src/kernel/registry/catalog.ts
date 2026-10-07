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

/** Where a media input arrives: as an attachment or as voice. */
type MediaInputChannel = 'attachments' | 'voice';

/** Rules support a subtype wildcard such as `image/*`; parameter values are ignored. */
function mimeAllowed(accept: readonly string[], mime: string): boolean {
  const actual = mimeEssence(mime);
  return accept.some((rule) => {
    const allowed = mimeEssence(rule);
    if (allowed.endsWith('/*')) {
      return actual.startsWith(allowed.slice(0, -1));
    }
    return allowed === actual;
  });
}

/** The kind of media a MIME type is, or `undefined` when it is not accepted. */
function mediaKindForMime(mime: string): MediaInputKind | undefined {
  return MEDIA_INPUT_KINDS[mimeEssence(mime)];
}

function profileInputs(profile: Profile): ProfileInputsSpec | undefined {
  return profile.type === 'text' || profile.type === 'image' || profile.type === 'live'
    ? profile.inputs
    : undefined;
}

function profileAccept(profile: Profile, channel: MediaInputChannel): string[] | undefined {
  const inputs = profileInputs(profile);
  return channel === 'voice' ? inputs?.voice?.accept : inputs?.attachments?.accept;
}

/**
 * `undefined` when the profile accepts it nowhere or the kernel cannot classify it. Hosts route
 * files with this instead of their own MIME table: the profile's `accept` lists are the whole declaration.
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

/** The profile's binding for the model id; throws when there is none. */
function requireModelBinding(profile: ModelProfile, modelId: ModelId): ModelBinding {
  const binding = profile.models[modelId];
  if (!binding) {
    throw new TheoremError('config', `Profile ${profile.id} has no model binding for '${modelId}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

/** The level if the binding accepts it, else the binding's default effort level, else its first listed level. */
function clampThinkingLevel(binding: ModelBinding, level: ThinkingLevel): ThinkingLevel {
  return clampLevels(binding, level);
}

/** The binding whose provider model id is `apiId`, or `undefined`. */
function modelEntryByApiId(
  bindings: Record<string, ModelBinding>,
  apiId: string,
): ModelBinding | undefined {
  return Object.values(bindings).find((m) => m.apiId === apiId);
}

/** The level if the binding for this provider model id accepts it, else that binding's default effort level, else its first listed level. */
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
