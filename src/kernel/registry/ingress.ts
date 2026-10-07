import { wrapContext, wrapUserData } from '../../guardrails/canary.ts';
import { TheoremError } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { contextText } from '../../guardrails/sanitize.ts';
import { synthesizeRepairPrompt } from '../engine/repair.ts';
import { CONTEXT_SENDERS } from '../schema.ts';
import { CONTINUE_INSTRUCTION_TYPES } from '../stop.ts';
import type {
  ImageResponseFormat,
  InteractionPart,
  MediaInputKind,
  Profile,
  TurnBlob,
  TurnMediaRef,
  TurnRequest,
} from '../types.ts';
import { isTurnMediaRef } from './attachments.ts';
import { mediaKindForMime, mimeEssence, profileInputs } from './catalog.ts';

type PrimaryOutputMode = 'structured' | 'image' | 'speech';

function activePrimaryOutputModes(
  profile: Profile,
  structuredId: string | null,
): PrimaryOutputMode[] {
  const modes: PrimaryOutputMode[] = [];
  if (structuredId) {
    modes.push('structured');
  }
  if (profile.type === 'image') {
    modes.push('image');
  }
  if (profile.type === 'speech') {
    modes.push('speech');
  }
  return modes;
}

/** Typed profiles already make mixed wire formats unrepresentable; this is a safety net. */
function assertOutputMode(profile: Profile, structuredId: string | null): void {
  const active = activePrimaryOutputModes(profile, structuredId);
  if (active.length <= 1) {
    return;
  }
  throw new TheoremError(
    'config',
    `Profile ${profile.id} declares multiple output wire formats (${active.join(', ')}). ` + // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      'Only one of a structured JSON schema (outputs.structured), image, or speech may be active.', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

function assertSpeechRole(profile: Profile, req: TurnRequest): void {
  if (profile.type !== 'speech') {
    return;
  }
  if (req.system) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} (speech) takes no system prompt — the input text is the transcript`, // lexicon-exempt: developer contract error
    );
  }
}

function resolveImageFormat(profile: Profile): ImageResponseFormat | null {
  if (profile.type !== 'image') {
    return null;
  }
  const pins = profile.image;
  return {
    type: 'image',
    mimeType: pins.mimeType,
    aspectRatio: pins.aspectRatio,
    resolution: pins.resolution,
    quality: pins.quality,
    background: pins.background,
    n: pins.n,
    seed: pins.seed,
    outputCompression: pins.outputCompression,
    includeText: pins.includeText === true,
  };
}

function assertMediaMime(mime: string): MediaInputKind {
  const kind = mediaKindForMime(mime);
  if (!kind) {
    throw new TheoremError('input', `MIME '${mime}' is not a supported media input type`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return kind;
}

/** Runs after `assertTurnAttachments`. A reference's uri passes untouched: the host owns the upload. */
function mediaParts(blobs: Array<TurnBlob | TurnMediaRef>): InteractionPart[] {
  return blobs.map((blob) => {
    const kind = assertMediaMime(blob.mimeType);
    const essence = mimeEssence(blob.mimeType);
    const mimeType = essence === 'image/jpg' ? 'image/jpeg' : essence;
    if (isTurnMediaRef(blob)) {
      return { type: kind, mimeType, uri: blob.uri };
    }
    return { type: kind, mimeType, data: blob.data };
  });
}

function extractTextPart(profile: Profile, req: TurnRequest): InteractionPart | null {
  const { text, repair, history } = req.input ?? {};
  if (profile.type === 'speech' && !text?.trim()) {
    throw new TheoremError('request', `Profile ${profile.id} (speech) requires text input`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (profileInputs(profile)?.text === false && text) {
    throw new TheoremError('request', `Profile ${profile.id} does not accept text input`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  // why: A repair is the kernel's, not the user's, so it applies even when the profile takes no user text.
  const promptText = repair
    ? synthesizeRepairPrompt({ profile, repair, history })
    : (continueText(profile, req) ?? text);
  const blocks = [...contextBlocks(req), ...(promptText ? [wrapUserData(promptText)] : [])];
  return blocks.length > 0 ? { type: 'text', text: blocks.join('\n\n') } : null;
}

/** Each sender's context in its own fence, the host's first: the model reads it before the user's message. */
function contextBlocks(req: TurnRequest): string[] {
  const context = req.input?.context ?? {};
  return [...CONTEXT_SENDERS]
    .reverse()
    .filter((sender) => context[sender] !== undefined)
    .map((sender) => wrapContext(sender, contextText(context[sender])));
}

/** Image and speech get none: their continue re-sends the host's request unchanged. */
function continueText(profile: Profile, req: TurnRequest): string | undefined {
  if (!req.continueFrom || !CONTINUE_INSTRUCTION_TYPES.includes(profile.type)) {
    return undefined;
  }
  if (req.input?.text) {
    throw new TheoremError(
      'request',
      `Profile ${profile.id}: a continueFrom turn takes no input.text — its user message is the continue instruction`, // lexicon-exempt: developer contract error
    );
  }
  return lexiconText('continue.instruction', {}, profile.lexicon);
}

function pinnedReferenceParts(profile: Profile): InteractionPart[] {
  return profile.type === 'image' && profile.image.references
    ? mediaParts(profile.image.references)
    : [];
}

/** `sanitizeTurnRequest` has already checked the blobs against the profile's limits and accept lists. */
function extractMediaParts(profile: Profile, req: TurnRequest): InteractionPart[] {
  const files = req.input?.attachments ?? [];
  const clips = req.input?.voice ?? [];
  return [...pinnedReferenceParts(profile), ...mediaParts(files), ...mediaParts(clips)];
}

function resolveInputParts(profile: Profile, req: TurnRequest): InteractionPart[] {
  const parts: InteractionPart[] = [];
  const textPart = extractTextPart(profile, req);
  if (textPart) {
    parts.push(textPart);
  }
  parts.push(...extractMediaParts(profile, req));
  return parts;
}

function assertTurnSlots(profile: Profile, req: TurnRequest): void {
  const slots = req.input?.slots;
  if (!slots) return;
  const declared = profileInputs(profile)?.slots ?? {};
  for (const [key, value] of Object.entries(slots)) {
    const choices = Object.hasOwn(declared, key) ? declared[key] : undefined;
    if (!choices) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id} has no slot '${key}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    if (!choices.includes(value)) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id}: slot '${key}' takes ${choices.join(', ')}, not '${value}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

/** Refuses context from a sender the profile's `inputs.context` does not list, and a package over its `maxChars`. */
function assertTurnContext(profile: Profile, req: TurnRequest): void {
  const context = req.input?.context;
  if (!context) return;
  const spec = profileInputs(profile)?.context;
  for (const [sender, value] of Object.entries(context)) {
    if (value === undefined) continue;
    const allowed = (CONTEXT_SENDERS as readonly string[]).includes(sender);
    if (!allowed || !spec?.from.some((from) => from === sender)) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id} takes no context from '${sender}'`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    if (contextText(value).length > spec.maxChars) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id}: context from '${sender}' is over inputs.context.maxChars (${String(spec.maxChars)})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  }
}

export {
  assertOutputMode,
  assertSpeechRole,
  assertTurnContext,
  assertTurnSlots,
  resolveImageFormat,
  resolveInputParts,
};
