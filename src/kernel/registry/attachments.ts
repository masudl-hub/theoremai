import { type ErrorCopy, TheoremError } from '../../guardrails/error.ts';
import { injectionSpans } from '../../guardrails/injection.ts';
import {
  type LexiconKey,
  type LexiconOverrides,
  type LexiconParams,
  lexiconText,
} from '../../guardrails/lexicon.ts';
import { sensitiveSpans } from '../../guardrails/sensitive.ts';
import { applySpans } from '../../observability/spans.ts';
import type {
  AttachmentValidationIssue,
  MediaLimits,
  MimeInputs,
  Profile,
  TurnBlob,
  TurnMediaRef,
} from '../types.ts';
import { base64ToBytes, bytesToBase64 } from '../util/base64.ts';
import { mimeEssence } from '../util/mime.ts';
import { mimeAllowed, profileAccept } from './catalog.ts';

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
    throw new TheoremError('request', `Profile ${profile.id} (speech) does not accept media input`); // lexicon-exempt: developer contract error
  }
  if (profile.type === 'live') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} (live) does not accept turn attachment input`, // lexicon-exempt: developer contract error
    );
  }
  if (profile.type === 'host' || profile.type === 'decision') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} (${profile.type}) does not accept turn input`, // lexicon-exempt: developer contract error
    );
  }
  const limits = resolveMediaLimits(profile.inputs ?? {});
  if (!limits) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`, // lexicon-exempt: developer contract error
    );
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

/** One file as validation sees it. `sizeBytes` is absent for provider references, which carry no bytes. */
export interface AttachmentFacts {
  name?: string;
  mimeType: string;
  sizeBytes?: number;
}

/**
 * What a profile takes: each channel's `accept` list (absent when it takes none)
 * and its complete limits.
 */
export interface AttachmentRules {
  attachments?: string[];
  voice?: string[];
  limits?: MediaLimits;
}

function named(
  issue: AttachmentValidationIssue,
  name: string | undefined,
): AttachmentValidationIssue {
  return name ? { ...issue, fileName: name } : issue;
}

function mimeIssues(
  accept: string[],
  files: AttachmentFacts[],
  channel: 'attachment' | 'voice',
): AttachmentValidationIssue[] {
  return files
    .filter((file) => !mimeAllowed(accept, file.mimeType))
    .map((file) =>
      named({ code: 'mime_not_allowed', params: { mimeType: file.mimeType, channel } }, file.name),
    );
}

function limitIssues(files: AttachmentFacts[], limits: MediaLimits): AttachmentValidationIssue[] {
  const issues: AttachmentValidationIssue[] = [];
  if (files.length > limits.maxFiles) {
    issues.push({ code: 'too_many_files', params: { maxFiles: limits.maxFiles } });
  }
  let total = 0;
  for (const file of files) {
    if (file.sizeBytes === undefined) continue;
    const maxAllowed = maxBytesForMime(file.mimeType, limits);
    if (file.sizeBytes > maxAllowed) {
      issues.push(named({ code: 'file_too_large', params: { maxBytes: maxAllowed } }, file.name));
    }
    total += file.sizeBytes;
  }
  if (total > limits.maxTurnBytes) {
    issues.push({ code: 'turn_too_large', params: { maxTurnBytes: limits.maxTurnBytes } });
  }
  return issues;
}

/**
 * Every reason a turn's files are refused, each file's naming that file. Empty
 * means the files are accepted. The one attachment check: the kernel throws on
 * it at ingress and the headless interface runs it before a send.
 */
function attachmentIssues(
  rules: AttachmentRules,
  files: AttachmentFacts[],
  clips: AttachmentFacts[],
): AttachmentValidationIssue[] {
  const issues: AttachmentValidationIssue[] = [];
  if (files.length > 0 && !rules.attachments) {
    issues.push({ code: 'attachments_not_accepted', params: { channel: 'attachment' } });
  }
  if (clips.length > 0 && !rules.voice) {
    issues.push({ code: 'voice_not_accepted', params: { channel: 'voice' } });
  }
  if (issues.length > 0) return issues;
  if (files.length === 0 && clips.length === 0) return issues;
  if (rules.attachments) issues.push(...mimeIssues(rules.attachments, files, 'attachment'));
  if (rules.voice) issues.push(...mimeIssues(rules.voice, clips, 'voice'));
  if (!rules.limits) return [...issues, { code: 'limits_unconfigured' }];
  return [...issues, ...limitIssues([...files, ...clips], rules.limits)];
}

const ISSUE_KEYS: Record<AttachmentValidationIssue['code'], LexiconKey> = {
  mime_not_allowed: 'attachments.mime_not_allowed',
  too_many_files: 'attachments.too_many_files',
  file_too_large: 'attachments.file_too_large',
  turn_too_large: 'attachments.turn_too_large',
  attachments_not_accepted: 'attachments.not_accepted',
  voice_not_accepted: 'attachments.not_accepted',
  limits_unconfigured: 'attachments.limits_unconfigured',
};

/** The lexicon line for one issue, with its parameters and the file's name. */
function attachmentIssueCopy(issue: AttachmentValidationIssue): ErrorCopy {
  const params: LexiconParams = {};
  for (const [key, value] of Object.entries(issue.params ?? {})) {
    if (value !== undefined) params[key] = value;
  }
  if (issue.fileName !== undefined) params.fileName = issue.fileName;
  return { key: ISSUE_KEYS[issue.code], params };
}

/** The user's line for one issue, in the profile's wording when `lexicon` is given. */
function attachmentIssueText(issue: AttachmentValidationIssue, lexicon?: LexiconOverrides): string {
  const copy = attachmentIssueCopy(issue);
  return lexiconText(copy.key, copy.params, lexicon);
}

/** The refusal for a turn's files: one `input` error whose copy carries a line per issue. */
function attachmentsRefused(issues: readonly AttachmentValidationIssue[]): TheoremError {
  return new TheoremError(
    'input',
    // lexicon-exempt: internal diagnostic; the user reads the copy lines
    `attachments refused: ${issues.map((issue) => issue.code).join(', ')}`,
    { copy: issues.map(attachmentIssueCopy) },
  );
}

function factsOf(item: TurnBlob | TurnMediaRef): AttachmentFacts {
  const facts: AttachmentFacts = { mimeType: item.mimeType };
  if (item.name) facts.name = item.name;
  if (isTurnMediaRef(item)) return facts;
  if (!B64_BODY.test(item.data)) {
    // lexicon-exempt: developer-facing wire-format diagnostic, not product copy
    throw new TheoremError('request', 'attachment data must be base64');
  }
  facts.sizeBytes = b64DecodedLen(item.data);
  return facts;
}

/**
 * Refuse a turn's files when any is not accepted, naming every reason: one
 * `input` error whose copy carries a line per issue. Provider references are
 * checked for MIME and count; byte limits apply to inline blobs only.
 */
function assertTurnAttachments(
  profile: Profile,
  attachments: Array<TurnBlob | TurnMediaRef> | undefined,
  voice: TurnBlob[] | undefined,
): void {
  if (!hasTurnBlobs(attachments, voice)) return;
  const limits = requireMediaLimits(profile);
  const issues = attachmentIssues(
    {
      attachments: profileAccept(profile, 'attachments'),
      voice: profileAccept(profile, 'voice'),
      limits,
    },
    (attachments ?? []).map(factsOf),
    (voice ?? []).map(factsOf),
  );
  if (issues.length > 0) throw attachmentsRefused(issues);
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
  return { ...blob, data: bytesToBase64(bytes) };
}

type TurnAttachments = Array<TurnBlob | TurnMediaRef>;

function hasTurnBlobs(attachments?: TurnAttachments, voice?: TurnBlob[]): boolean {
  return (attachments?.length ?? 0) > 0 || (voice?.length ?? 0) > 0;
}

/**
 * Refuses files the profile does not accept (every reason at once), then
 * sanitizes inline text and CSV blobs. Provider file references pass through
 * unchanged because the kernel has no bytes to scan. Names ride along.
 */
function sanitizeTurnBlobs(
  profile: Profile,
  attachments: Array<TurnBlob | TurnMediaRef> | undefined,
  voice: TurnBlob[] | undefined,
): { attachments?: Array<TurnBlob | TurnMediaRef>; voice?: TurnBlob[] } {
  if (!hasTurnBlobs(attachments, voice)) {
    return { attachments, voice };
  }
  assertTurnAttachments(profile, attachments, voice);
  return {
    attachments: attachments?.length ? attachments.map(sanitizeAttachment) : attachments,
    voice: voice?.length ? voice.map(sanitizeAttachment) : voice,
  };
}

export {
  assertTurnAttachments,
  attachmentIssueCopy,
  attachmentIssues,
  attachmentIssueText,
  attachmentsRefused,
  isTurnMediaRef,
  maxBytesForMime,
  requireMediaLimits,
  resolveMediaLimits,
  sanitizeCsvText,
  sanitizeTurnBlobs,
};
