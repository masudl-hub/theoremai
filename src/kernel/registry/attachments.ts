import { TheoremError } from '../../guardrails/error.ts';
import { injectionSpans } from '../../guardrails/injection.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import { sensitiveSpans } from '../../guardrails/sensitive.ts';
import { applySpans } from '../../observability/spans.ts';
import type { MediaLimits, MimeInputs, Profile, TurnBlob, TurnMediaRef } from '../types.ts';
import { base64ToBytes, bytesToBase64 } from '../util/base64.ts';
import { mimeEssence } from '../util/mime.ts';
import { getProfile } from './profiles.ts';

const B64_PAD = 2;
const B64_WORD = 4;
const B64_TRIPLET = 3;

const CSV_FORMULA = /(^|,)(\s*)("?)(?:([=@])|([+-])(?![0-9."]))/gm;
const B64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
const TEXT_MIMES = new Set(['text/csv', 'text/plain', 'text/markdown']);
/** Returns complete attachment limits only when every required global limit is set. */
function resolveMediaLimits(inputs: MimeInputs): MediaLimits | undefined {
  const { maxFiles, maxBytes, maxTurnBytes, limitsByMime } = inputs;
  if (maxFiles && maxBytes && maxTurnBytes) {
    return { maxFiles, maxBytes, maxTurnBytes, limitsByMime };
  }
  return undefined;
}

/** Resolves a MIME-specific byte cap, then its category wildcard, then the global cap. */
function maxBytesForMime(mimeType: string, limits: MediaLimits): number {
  if (limits.limitsByMime) {
    const cleanMime = mimeEssence(mimeType);
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

/**
 * Returns a turn-capable profile's attachment limits or throws when its profile
 * type cannot accept attachments or it omitted a complete limits declaration.
 */
function requireMediaLimits(profile: Profile): MediaLimits {
  if (profile.type === 'speech') {
    throw new TheoremError(`Profile ${profile.id} (speech) does not accept media input`); // lexicon-exempt: developer contract error
  }
  if (profile.type === 'live') {
    throw new TheoremError(`Profile ${profile.id} (live) does not accept turn attachment input`); // lexicon-exempt: developer contract error
  }
  if (profile.type === 'host' || profile.type === 'decision') {
    throw new TheoremError(`Profile ${profile.id} (host) does not accept turn input`); // lexicon-exempt: developer contract error
  }
  const limits = resolveMediaLimits(profile.inputs ?? {});
  if (!limits) {
    throw new TheoremError(`Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`); // lexicon-exempt: developer contract error
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

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Prefixes CSV formula-like cells with an apostrophe before they reach a model. */
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
    throw new TheoremError(
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
      throw new TheoremError('attachment data must be base64');
    }
    const size = b64DecodedLen(data);
    const maxAllowed = maxBytesForMime(mimeType, limits);
    if (size > maxAllowed) {
      throw new TheoremError(lexiconText('attachments.file_too_large', { maxBytes: maxAllowed }));
    }
    total += size;
  }
  if (total > limits.maxTurnBytes) {
    throw new TheoremError(
      lexiconText('attachments.turn_too_large', { maxTurnBytes: limits.maxTurnBytes }),
    );
  }
}

function sanitizeAttachment<T extends TurnBlob | TurnMediaRef>(blob: T): T {
  if (isTurnMediaRef(blob)) {
    return blob;
  }
  const { mimeType, data } = blob;
  if (!TEXT_MIMES.has(mimeEssence(mimeType))) {
    return blob;
  }
  const bytes = sanitizeTextBytes(mimeType, base64ToBytes(data));
  return { mimeType, data: bytesToBase64(bytes) } as T;
}

type TurnAttachments = Array<TurnBlob | TurnMediaRef>;

function hasTurnBlobs(attachments?: TurnAttachments, voice?: TurnBlob[]): boolean {
  return (attachments?.length ?? 0) > 0 || (voice?.length ?? 0) > 0;
}

/**
 * Enforces attachment limits and sanitizes inline text and CSV blobs. Provider
 * file references pass through unchanged because the kernel has no bytes to scan.
 */
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
    throw new TheoremError(lexiconText('attachments.not_accepted', { channel: 'file' }));
  }
  assertAttachmentLimits([...files, ...clips], limits);
  return {
    attachments: files.length > 0 ? files.map(sanitizeAttachment) : attachments,
    voice: clips.length > 0 ? clips.map(sanitizeAttachment) : voice,
  };
}

/** Looks up a profile's limits before sanitizing its turn attachments and voice blobs. */
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
