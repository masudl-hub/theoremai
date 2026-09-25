/**
 * Kernel ingress: input parts, image pins, and speech-role checks.
 *
 * Owned by the kernel so `resolveTurn` does not import provider adapters.
 *
 * @module
 */

import { wrapUserData } from '../../guardrails/canary.ts';
import { TheoremError } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { synthesizeRepairPrompt } from '../engine/repair.ts';
import { isSpeechFormatAllowedForProtocol } from '../schema.ts';
import { CONTINUE_INSTRUCTION_TYPES } from '../stop.ts';
import type {
  ImageResponseFormat,
  InteractionPart,
  MediaInputKind,
  ModelBinding,
  Profile,
  ProfileImageSpec,
  TurnBlob,
  TurnMediaRef,
  TurnRequest,
} from '../types.ts';
import { assertTurnAttachments, isTurnMediaRef } from './attachments.ts';
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

/**
 * Provider wire formats (JSON schema, image, speech) are mutually exclusive.
 * Typed profiles make illegal mixes unrepresentable; this remains a safety net
 * for responseFormat structured on text vs accidental dual modes.
 */
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

function assertImagePins(profile: Profile): ProfileImageSpec {
  if (profile.type !== 'image') {
    throw new TheoremError('request', `Profile ${profile.id} is not type 'image'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return profile.image;
}

/** Speech turns: the selected model's transport must take the format, and no system prompt rides along. */
function assertSpeechRole(profile: Profile, binding: ModelBinding, req: TurnRequest): void {
  if (profile.type !== 'speech') {
    return;
  }
  if (req.system) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} (speech) takes no system prompt — the input text is the transcript`, // lexicon-exempt: developer contract error
    );
  }
  const format = profile.speech.format;
  if (format && !isSpeechFormatAllowedForProtocol(binding.protocol, format)) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: speech.format '${format}' requires protocol 'openAi' ` + // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        `(geminiInteractions speech returns PCM and emits WAV)`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

function resolveImageFormat(profile: Profile): ImageResponseFormat | null {
  if (profile.type !== 'image') {
    return null;
  }
  const pins = assertImagePins(profile);
  return {
    type: 'image',
    mimeType: pins.mimeType,
    aspectRatio: pins.aspectRatio,
    size: pins.size,
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

/**
 * Normalize accepted attachments (`assertTurnAttachments` ran first) into
 * provider parts. Inline blobs and references share kind resolution; references carry the
 * uri through untouched (no base64, no byte limits — the host owns the upload).
 */
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
  if (profile.type === 'decision') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} (decision) does not accept turn input`, // lexicon-exempt: developer contract error
    );
  }
  if (profile.type === 'speech' && !text?.trim()) {
    throw new TheoremError('request', `Profile ${profile.id} (speech) requires text input`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (profileInputs(profile)?.text === false && text) {
    throw new TheoremError('request', `Profile ${profile.id} does not accept text input`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  // A repair is the kernel's, not the user's: it replaces the text on a retry
  // whether or not the profile takes text from the user.
  const promptText = repair
    ? synthesizeRepairPrompt({ profile, repair, history })
    : (continueText(profile, req) ?? text);
  return promptText ? { type: 'text', text: wrapUserData(promptText) } : null;
}

/**
 * A text `continueFrom` turn's user message is the continue instruction, so the
 * model reads history → partial reply → "continue". Image and speech get none:
 * their continue re-sends the host's request unchanged.
 */
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

function extractMediaParts(profile: Profile, req: TurnRequest): InteractionPart[] {
  if (profile.type === 'speech') {
    const { attachments, voice } = req.input ?? {};
    if ((attachments?.length ?? 0) + (voice?.length ?? 0) > 0) {
      throw new TheoremError('input', `Profile ${profile.id} (speech) does not accept media input`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    return [];
  }
  const { attachments, voice } = req.input ?? {};
  const files = attachments ?? [];
  const clips = voice ?? [];
  assertTurnAttachments(profile, files, clips);
  const parts: InteractionPart[] = [];
  if (files.length > 0) {
    parts.push(...mediaParts(files));
  }
  if (clips.length > 0) {
    parts.push(...mediaParts(clips));
  }
  return parts;
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

export { assertOutputMode, assertSpeechRole, resolveImageFormat, resolveInputParts };
