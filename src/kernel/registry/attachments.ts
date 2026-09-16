import { TheorumError } from '../../guardrails/error.ts';
import { injectionSpans } from '../../guardrails/injection.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { sensitiveSpans } from '../../guardrails/sensitive.ts';
import { applySpans } from '../../observability/spans.ts';
import type { MediaLimits, MimeInputs, Profile, TurnBlob, TurnMediaRef } from '../types.ts';
import { getProfile } from './profiles.ts';

const B64_PAD = 2;
const B64_WORD = 4;
const B64_TRIPLET = 3;

const CSV_FORMULA = /(^|,)(\s*)("?)(?:([=@])|([+-])(?![0-9."]))/gm;
const B64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const TEXT_MIMES = new Set(['text/csv', 'text/plain', 'text/markdown']);
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

/** Attachment supplied by provider file reference — no bytes to size-check or sanitize. */
function isTurnMediaRef(item: TurnBlob | TurnMediaRef): item is TurnMediaRef {
  return 'uri' in item;
}

function requireMediaLimits(profile: Profile): MediaLimits {
  if (profile.type === 'speech') {
    throw new TheorumError(`Profile ${profile.id} (speech) does not accept media input`); // lexicon-exempt: developer contract error
  }
  if (profile.type === 'live') {
    throw new TheorumError(`Profile ${profile.id} (live) does not accept turn attachment input`); // lexicon-exempt: developer contract error
  }
  if (profile.type === 'host') {
    throw new TheorumError(`Profile ${profile.id} (host) does not accept turn input`); // lexicon-exempt: developer contract error
  }
  const limits = resolveMediaLimits(profile.inputs ?? {});
  if (!limits) {
    throw new TheorumError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`); // lexicon-exempt: developer contract error
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

/** Enforce file count on every attachment; base64 and byte limits only on inline blobs. */
function assertAttachmentLimits(
  attachments: Array<TurnBlob | TurnMediaRef>,
  limits: MediaLimits,
): void {
  if (attachments.length > limits.maxFiles) {
    throw new TheorumError(
      lexiconText('attachments.too_many_files', { maxFiles: limits.maxFiles }),
    );
  }
  let total = 0;
  for (const blob of attachments) {
    if (isTurnMediaRef(blob)) {
      continue;
    }
    const { data, mimeType } = blob;
    if (!B64_BODY.test(data)) {
      // lexicon-exempt: developer-facing wire-format diagnostic, not product copy
      throw new TheorumError('attachment data must be base64');
    }
    const size = b64DecodedLen(data);
    const maxAllowed = maxBytesForMime(mimeType, limits);
    if (size > maxAllowed) {
      throw new TheorumError(lexiconText('attachments.file_too_large', { maxBytes: maxAllowed }));
    }
    total += size;
  }
  if (total > limits.maxTurnBytes) {
    throw new TheorumError(
      lexiconText('attachments.turn_too_large', { maxTurnBytes: limits.maxTurnBytes }),
    );
  }
}

function sanitizeAttachment<T extends TurnBlob | TurnMediaRef>(blob: T): T {
  if (isTurnMediaRef(blob)) {
    return blob;
  }
  const { mimeType, data } = blob;
  if (!TEXT_MIMES.has(mimeType.split(';')[0]?.trim().toLowerCase() ?? '')) {
    return blob;
  }
  const bytes = sanitizeTextBytes(mimeType, decodeB64(data));
  return { mimeType, data: encodeB64(bytes) } as T;
}

type TurnAttachments = Array<TurnBlob | TurnMediaRef>;

function hasTurnBlobs(attachments?: TurnAttachments, voice?: TurnBlob[]): boolean {
  return (attachments?.length ?? 0) > 0 || (voice?.length ?? 0) > 0;
}

function sanitizeTurnBlobs(
  attachments: Array<TurnBlob | TurnMediaRef> | undefined,
  voice: TurnBlob[] | undefined,
  limits: MediaLimits | undefined,
): { attachments?: Array<TurnBlob | TurnMediaRef>; voice?: TurnBlob[] } {
  if (!hasTurnBlobs(attachments, voice)) {
    return { attachments, voice };
  }
  const files = attachments ?? [];
  const clips = voice ?? [];
  if (!limits) {
    throw new TheorumError(lexiconText('attachments.not_accepted', { channel: 'file' }));
  }
  assertAttachmentLimits([...files, ...clips], limits);
  return {
    attachments: files.length > 0 ? files.map(sanitizeAttachment) : attachments,
    voice: clips.length > 0 ? clips.map(sanitizeAttachment) : voice,
  };
}

function sanitizeTurnBlobsForProfile(
  profileId: string,
  attachments: Array<TurnBlob | TurnMediaRef> | undefined,
  voice: TurnBlob[] | undefined,
): { attachments?: Array<TurnBlob | TurnMediaRef>; voice?: TurnBlob[] } {
  if (!hasTurnBlobs(attachments, voice)) {
    return { attachments, voice };
  }
  const limits = requireMediaLimits(getProfile(profileId));
  return sanitizeTurnBlobs(attachments, voice, limits);
}

export {
  assertAttachmentLimits,
  isTurnMediaRef,
  maxBytesForMime,
  requireMediaLimits,
  resolveMediaLimits,
  sanitizeCsvText,
  sanitizeTurnBlobs,
  sanitizeTurnBlobsForProfile,
};
