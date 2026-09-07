import { TheorumError } from '../../guardrails/error.ts';
import { injectionSpans } from '../../guardrails/injection.ts';
import { sensitiveSpans } from '../../guardrails/sensitive.ts';
import { applySpans } from '../../observability/spans.ts';
import type { MediaLimits, MimeInputs, Profile, TurnBlob } from '../types.ts';
import { getProfile } from './profiles.ts';

const B64_PAD = 2;
const B64_WORD = 4;
const B64_TRIPLET = 3;

const CSV_FORMULA = /(^|,)(\s*)("?)(?:([=@])|([+-])(?![0-9."]))/gm;
const B64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const TEXT_MIMES = new Set(['text/csv', 'text/plain', 'text/markdown']);
const BYTES_PER_KIB = 1024;

function formatMb(bytes: number): string {
  const mb = bytes / (BYTES_PER_KIB * BYTES_PER_KIB);
  return Number.isInteger(mb) ? `${String(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function tooManyFilesMessage(maxFiles: number): string {
  return maxFiles === 1
    ? 'Only 1 file per message.'
    : `Only ${String(maxFiles)} files per message.`;
}

function fileTooLargeMessage(maxBytes: number): string {
  return `Each file must be ${formatMb(maxBytes)} or smaller.`;
}

function turnTooLargeMessage(maxTurnBytes: number): string {
  return `Those files together are too large for one message (${formatMb(maxTurnBytes)} max).`;
}

function resolveMediaLimits(inputs: MimeInputs): MediaLimits | undefined {
  const { maxFiles, maxBytes, maxTurnBytes, limitsByMime } = inputs;
  if (maxFiles && maxBytes && maxTurnBytes) {
    return { maxFiles, maxBytes, maxTurnBytes, limitsByMime };
  }
  return undefined;
}

function maxBytesForMime(mimeType: string, limits: MediaLimits): number {
  if (limits.limitsByMime) {
    const cleanMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (limits.limitsByMime[cleanMime]) {
      return limits.limitsByMime[cleanMime];
    }
    const [category] = cleanMime.split('/');
    const wildCard = `${category}/*`;
    if (limits.limitsByMime[wildCard]) {
      return limits.limitsByMime[wildCard];
    }
  }
  return limits.maxBytes;
}

function requireMediaLimits(profile: Profile): MediaLimits {
  if (profile.type === 'speech') {
    throw new TheorumError(`Profile ${profile.id} (speech) does not accept media input`);
  }
  if (profile.type === 'live') {
    throw new TheorumError(`Profile ${profile.id} (live) does not accept turn attachment input`);
  }
  const limits = resolveMediaLimits(profile.inputs ?? {});
  if (!limits) {
    throw new TheorumError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`);
  }
  return limits;
}

function b64DecodedLen(data: string): number {
  let pad = 0;
  if (data.endsWith('==')) {
    pad = B64_PAD;
  } else if (data.endsWith('=')) {
    pad = 1;
  }
  return Math.floor((data.length * B64_TRIPLET) / B64_WORD) - pad;
}

function decodeB64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function sanitizeCsvText(text: string): string {
  return text.replace(CSV_FORMULA, (_full, ...groups: string[]) => {
    const [a, b, c, d, e] = groups;
    return `${a}${b}${c}'${d ?? ''}${e ?? ''}`;
  });
}

function sanitizeTextBytes(mime: string, bytes: Uint8Array): Uint8Array {
  let text = decodeText(bytes);
  if (mime === 'text/csv') {
    text = sanitizeCsvText(text);
  }
  return new TextEncoder().encode(
    applySpans(text, [...injectionSpans(text), ...sensitiveSpans(text)]),
  );
}

function assertAttachmentLimits(blobs: TurnBlob[], limits: MediaLimits): void {
  if (blobs.length > limits.maxFiles) {
    throw new TheorumError(tooManyFilesMessage(limits.maxFiles));
  }
  let total = 0;
  for (const blob of blobs) {
    const { data, mimeType } = blob;
    if (!B64_BODY.test(data)) {
      throw new TheorumError('attachment data must be base64');
    }
    const size = b64DecodedLen(data);
    const maxAllowed = maxBytesForMime(mimeType, limits);
    if (size > maxAllowed) {
      throw new TheorumError(fileTooLargeMessage(maxAllowed));
    }
    total += size;
  }
  if (total > limits.maxTurnBytes) {
    throw new TheorumError(turnTooLargeMessage(limits.maxTurnBytes));
  }
}

function sanitizeAttachment(blob: TurnBlob): TurnBlob {
  const { mimeType, data } = blob;
  if (!TEXT_MIMES.has(mimeType.split(';')[0]?.trim().toLowerCase() ?? '')) {
    return blob;
  }
  const bytes = sanitizeTextBytes(mimeType, decodeB64(data));
  return { mimeType, data: encodeB64(bytes) };
}

function hasTurnBlobs(attachments?: TurnBlob[], voice?: TurnBlob[]): boolean {
  return (attachments?.length ?? 0) > 0 || (voice?.length ?? 0) > 0;
}

function sanitizeTurnBlobs(
  attachments: TurnBlob[] | undefined,
  voice: TurnBlob[] | undefined,
  limits: MediaLimits | undefined,
): { attachments?: TurnBlob[]; voice?: TurnBlob[] } {
  if (!hasTurnBlobs(attachments, voice)) {
    return { attachments, voice };
  }
  const files = attachments ?? [];
  const clips = voice ?? [];
  if (!limits) {
    throw new TheorumError('This profile does not accept files.');
  }
  assertAttachmentLimits([...files, ...clips], limits);
  return {
    attachments: files.length > 0 ? files.map(sanitizeAttachment) : attachments,
    voice: clips.length > 0 ? clips.map(sanitizeAttachment) : voice,
  };
}

function sanitizeTurnBlobsForProfile(
  profileId: string,
  attachments: TurnBlob[] | undefined,
  voice: TurnBlob[] | undefined,
): { attachments?: TurnBlob[]; voice?: TurnBlob[] } {
  if (!hasTurnBlobs(attachments, voice)) {
    return { attachments, voice };
  }
  const limits = requireMediaLimits(getProfile(profileId));
  return sanitizeTurnBlobs(attachments, voice, limits);
}

export {
  assertAttachmentLimits,
  fileTooLargeMessage,
  maxBytesForMime,
  requireMediaLimits,
  resolveMediaLimits,
  sanitizeCsvText,
  sanitizeTurnBlobs,
  sanitizeTurnBlobsForProfile,
  tooManyFilesMessage,
  turnTooLargeMessage,
};
