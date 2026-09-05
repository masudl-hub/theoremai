/**
 * Kernel ingress: input parts, image pins, and speech-role checks.
 *
 * Owned by the kernel so `resolveTurn` does not import provider adapters.
 *
 * @module
 */

import { wrapUserData } from '../../guardrails/canary.ts';
import { TheorumError } from '../../guardrails/error.ts';
import { synthesizeRepairPrompt } from '../engine/repair.ts';
import type {
  ImageResponseFormat,
  InteractionPart,
  MediaInputKind,
  ModelId,
  Profile,
  ProfileImageSpec,
  TurnBlob,
  TurnRequest,
} from '../types.ts';
import { assertAttachmentLimits, requireMediaLimits } from './attachments.ts';
import { mediaKindForMime, mimeAllowed, mimeEssence } from './catalog.ts';
import { getStructured } from './schemas.ts';

type PrimaryOutputMode = 'structured' | 'image' | 'speech';

function usesStructuredResponseFormat(structuredId: string | null): boolean {
  if (!structuredId) {
    return false;
  }
  const spec = getStructured(structuredId);
  return spec.enforced === 'responseFormat' && spec.jsonSchema != null;
}

function activePrimaryOutputModes(
  profile: Profile,
  structuredId: string | null,
): PrimaryOutputMode[] {
  const modes: PrimaryOutputMode[] = [];
  if (usesStructuredResponseFormat(structuredId)) {
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
  throw new TheorumError(
    `Profile ${profile.id} declares multiple output wire formats (${active.join(', ')}). ` +
      `Only one of responseFormat JSON schema (outputs.structured with enforced ` +
      `'responseFormat'), image, or speech may be active.`,
  );
}

function assertImagePins(profile: Profile): ProfileImageSpec {
  if (profile.type !== 'image') {
    throw new TheorumError(`Profile ${profile.id} is not type 'image'`);
  }
  return profile.image;
}

function assertSpeechRole(profile: Profile): void {
  if (profile.type !== 'speech') {
    return;
  }
  if (profile.speech.format === 'mp3' && profile.model.protocol === 'geminiInteractions') {
    throw new TheorumError(
      `Profile ${profile.id}: speech.format 'mp3' requires protocol 'openAi' ` +
        `(geminiInteractions speech returns PCM and emits WAV)`,
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
    throw new TheorumError(`MIME '${mime}' is not a supported media input type`);
  }
  return kind;
}

function profileInputs(profile: Profile) {
  if (profile.type === 'speech') {
    return undefined;
  }
  return profile.inputs;
}

function mediaParts(
  profile: Profile,
  model: ModelId,
  blobs: TurnBlob[],
  channel: 'attachments' | 'voice',
): InteractionPart[] {
  const inputs = profileInputs(profile);
  const accept = channel === 'voice' ? inputs?.voice?.accept : inputs?.attachments?.accept;
  if (!accept) {
    throw new TheorumError(`Profile ${profile.id} does not accept ${channel}`);
  }
  const maxInputImages = profile.type === 'image' ? profile.image.maxInputImages : undefined;
  const imageCount = blobs.filter((blob) => mediaKindForMime(blob.mimeType) === 'image').length;
  if (maxInputImages !== undefined && imageCount > maxInputImages) {
    throw new TheorumError(`At most ${maxInputImages} reference images on ${model}`);
  }
  return blobs.map((blob) => {
    const kind = assertMediaMime(blob.mimeType);
    if (!mimeAllowed(accept, blob.mimeType)) {
      throw new TheorumError(`MIME '${blob.mimeType}' is not accepted on ${profile.id}`);
    }
    const essence = mimeEssence(blob.mimeType);
    return {
      type: kind,
      mimeType: essence === 'image/jpg' ? 'image/jpeg' : essence,
      data: blob.data,
    };
  });
}

function extractTextPart(profile: Profile, req: TurnRequest): InteractionPart | null {
  const { text, repair, history } = req.input ?? {};
  if (profile.type === 'speech') {
    if (!text?.trim()) {
      throw new TheorumError(`Profile ${profile.id} (speech) requires text input`);
    }
    let promptText = text;
    if (repair) {
      promptText = synthesizeRepairPrompt({ profile, repair, history });
    }
    return { type: 'text', text: wrapUserData(promptText) };
  }
  const inputs = profileInputs(profile);
  if (inputs?.text === false) {
    if (text) {
      throw new TheorumError(`Profile ${profile.id} does not accept text input`);
    }
    return null;
  }
  let promptText = text;
  if (repair) {
    promptText = synthesizeRepairPrompt({ profile, repair, history });
  }
  if (!promptText) {
    return null;
  }
  return { type: 'text', text: wrapUserData(promptText) };
}

function extractMediaParts(profile: Profile, model: ModelId, req: TurnRequest): InteractionPart[] {
  if (profile.type === 'speech') {
    const { attachments, voice } = req.input ?? {};
    if ((attachments?.length ?? 0) + (voice?.length ?? 0) > 0) {
      throw new TheorumError(`Profile ${profile.id} (speech) does not accept media input`);
    }
    return [];
  }
  const { attachments, voice } = req.input ?? {};
  const files = attachments ?? [];
  const clips = voice ?? [];
  if (files.length + clips.length > 0) {
    assertAttachmentLimits([...files, ...clips], requireMediaLimits(profile));
  }
  const parts: InteractionPart[] = [];
  if (files.length > 0) {
    parts.push(...mediaParts(profile, model, files, 'attachments'));
  }
  if (clips.length > 0) {
    parts.push(...mediaParts(profile, model, clips, 'voice'));
  }
  return parts;
}

function resolveInputParts(profile: Profile, model: ModelId, req: TurnRequest): InteractionPart[] {
  const parts: InteractionPart[] = [];
  const textPart = extractTextPart(profile, req);
  if (textPart) {
    parts.push(textPart);
  }
  parts.push(...extractMediaParts(profile, model, req));
  return parts;
}

export { assertOutputMode, assertSpeechRole, resolveImageFormat, resolveInputParts };
