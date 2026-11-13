import type { BoundaryReader } from '../../guardrails/detect-at.ts';
import { type ErrorCopy, TheoremError } from '../../guardrails/error.ts';
import {
  type LabelKey,
  type LabelOverrides,
  type LabelParams,
  labelText,
} from '../../guardrails/labels.ts';
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
/** The media limits an inputs spec sets, or `undefined` unless it sets `maxFiles`, `maxBytes`, and `maxTurnBytes`. */
function resolveMediaLimits(inputs: MimeInputs): MediaLimits | undefined {
  const { maxFiles, maxBytes, maxTurnBytes, limitsByMime } = inputs;
  if (maxFiles && maxBytes && maxTurnBytes) {
    return { maxFiles, maxBytes, maxTurnBytes, limitsByMime };
  }
  return undefined;
}

/** A MIME-specific cap, then its category wildcard, then the global cap. */
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

function isTurnMediaRef(item: TurnBlob | TurnMediaRef): item is TurnMediaRef {
  return 'uri' in item;
}

/** The profile's media limits; throws when it takes no media. */
function requireMediaLimits(profile: Profile): MediaLimits {
  if (profile.type === 'speech') {
    throw new TheoremError('request', `Profile ${profile.id} (speech) does not accept media input`); // labels-exempt: developer contract error
  }
  if (profile.type === 'live') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} (live) does not accept turn attachment input`, // labels-exempt: developer contract error
    );
  }
  if (profile.type === 'host' || profile.type === 'decision' || profile.type === 'embedding') {
    throw new TheoremError(
      'request',
      `Profile ${profile.id} (${profile.type}) does not accept turn input`, // labels-exempt: developer contract error
    );
  }
  const limits = resolveMediaLimits(profile.inputs ?? {});
  if (!limits) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id} must set maxFiles, maxBytes, and maxTurnBytes`, // labels-exempt: developer contract error
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

/**
 * How a text file's bytes spell its text, so a changed text is written back the same way:
 * UTF-8, UTF-16, a single-byte charset through its table, or `bytes`, one byte to one character,
 * for a charset with no table.
 */
type TextEncoding =
  | { kind: 'utf-8' | 'utf-16le' | 'utf-16be' }
  | { kind: 'table'; table: ByteTable }
  | { kind: 'bytes'; name: string };

interface ByteTable {
  chars: readonly string[];
  bytes: ReadonlyMap<string, number>;
}

interface DecodedText {
  text: string;
  encoding: TextEncoding;
  /** The byte order mark the file opened with, kept when it is written back. */
  bom: boolean;
}

const BOMS: readonly ['utf-8' | 'utf-16le' | 'utf-16be', readonly number[]][] = [
  ['utf-8', [0xef, 0xbb, 0xbf]],
  ['utf-16le', [0xff, 0xfe]],
  ['utf-16be', [0xfe, 0xff]],
];
const CHUNK = 0x8000;
const CHARSET = /(;\s*charset\s*=\s*)("[^"]*"|[^;\s]+)/i;
/** why: what a browser reads text with no charset in when it is not UTF-8. */
const FALLBACK_CHARSET = 'windows-1252';
const tables = new Map<string, ByteTable | null>();

/** The `charset` a MIME type names, lowercased. */
function charsetOf(mimeType: string): string | undefined {
  return CHARSET.exec(mimeType)?.[2]?.replaceAll('"', '').toLowerCase();
}

/** The encoding a charset label names, as the decoder knows it; `undefined` for one it does not know. */
function encodingName(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

/** A single-byte charset's table, each byte to one character and back; `null` for a charset that is not one. */
function byteTable(name: string): ByteTable | null {
  const known = tables.get(name);
  if (known !== undefined) return known;
  const decoder = new TextDecoder(name);
  const chars = Array.from({ length: 256 }, (_, byte) => decoder.decode(Uint8Array.of(byte)));
  const bytes = new Map(chars.map((char, byte) => [char, byte]));
  const table =
    chars.every((char) => char.length === 1) && bytes.size === 256 ? { chars, bytes } : null;
  tables.set(name, table);
  return table;
}

function validUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Text as its bytes spell it: a byte order mark first, then the charset the type names, then UTF-8 when it is valid. */
function decodeText(mimeType: string, bytes: Uint8Array): DecodedText {
  for (const [kind, mark] of BOMS) {
    if (mark.every((byte, index) => bytes[index] === byte)) {
      const body = bytes.subarray(mark.length);
      return { text: decodeAs({ kind }, body), encoding: { kind }, bom: true };
    }
  }
  const label = charsetOf(mimeType);
  const named = label === undefined ? undefined : encodingName(label);
  if (named === 'utf-16le' || named === 'utf-16be') return decodedAs({ kind: named }, bytes);
  const table = named === undefined || named === 'utf-8' ? null : byteTable(named);
  if (table) return decodedAs({ kind: 'table', table }, bytes);
  // why: a charset with no table, such as Shift_JIS, is read byte for byte, so its ASCII is read and every byte comes back as it was.
  if (named !== undefined && named !== 'utf-8')
    return decodedAs({ kind: 'bytes', name: named }, bytes);
  const utf8 = validUtf8(bytes);
  if (utf8 !== undefined) return { text: utf8, encoding: { kind: 'utf-8' }, bom: false };
  const fallback = byteTable(FALLBACK_CHARSET);
  if (!fallback) throw new TheoremError('internal', `${FALLBACK_CHARSET} has no byte table`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return decodedAs({ kind: 'table', table: fallback }, bytes);
}

function decodedAs(encoding: TextEncoding, bytes: Uint8Array): DecodedText {
  return { text: decodeAs(encoding, bytes), encoding, bom: false };
}

function decodeAs(encoding: TextEncoding, bytes: Uint8Array): string {
  if (encoding.kind === 'utf-8' || encoding.kind === 'utf-16le' || encoding.kind === 'utf-16be') {
    return new TextDecoder(encoding.kind, { ignoreBOM: true }).decode(bytes);
  }
  const chars = encoding.kind === 'table' ? encoding.table.chars : undefined;
  let text = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const chunk = bytes.subarray(at, at + CHUNK);
    text += chars
      ? Array.from(chunk, (byte) => chars[byte]).join('')
      : String.fromCharCode(...chunk);
  }
  return text;
}

function encodeAs(encoding: TextEncoding, text: string): Uint8Array {
  if (encoding.kind === 'utf-8') return new TextEncoder().encode(text);
  if (encoding.kind === 'utf-16le' || encoding.kind === 'utf-16be') {
    const bytes = new Uint8Array(text.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < text.length; index++) {
      view.setUint16(index * 2, text.charCodeAt(index), encoding.kind === 'utf-16le');
    }
    return bytes;
  }
  const table = encoding.kind === 'table' ? encoding.table.bytes : undefined;
  const bytes: number[] = [];
  for (const char of text) {
    const byte = table ? table.get(char) : latin1Byte(char);
    // why: a character the charset has no byte for can only come from the guard's own placeholder, which is written as UTF-8.
    if (byte === undefined) bytes.push(...new TextEncoder().encode(char));
    else bytes.push(byte);
  }
  return Uint8Array.from(bytes);
}

function latin1Byte(char: string): number | undefined {
  const code = char.charCodeAt(0);
  return char.length === 1 && code <= 0xff ? code : undefined;
}

/** CSV formula injection: formula-like cells get an apostrophe before they reach a model. */
function sanitizeCsvText(text: string): string {
  return text.replace(CSV_FORMULA, (_full, ...groups: string[]) => {
    const [a, b, c, d, e] = groups;
    return `${a}${b}${c}'${d ?? ''}${e ?? ''}`;
  });
}

/** Whether a file of this type is text the detectors read once decoded. */
function isTextFile(mimeType: string): boolean {
  return TEXT_MIMES.has(mimeEssence(mimeType));
}

/** A text file's base64 bytes, decoded; `null` when they are not base64. */
function decodeTextFile(mimeType: string, data: string): DecodedText | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(data);
  } catch {
    return null;
  }
  return decodeText(mimeType, bytes);
}

/** Whether a text file's bytes are base64, so it can be decoded and read. */
function isTextFileData(mimeType: string, data: string): boolean {
  return decodeTextFile(mimeType, data) !== null;
}

/** A text file's text; throws when its bytes are not base64, which every source of a file refuses first. */
function textFileText(mimeType: string, data: string): string {
  const decoded = decodeTextFile(mimeType, data);
  if (decoded === null) {
    throw new TheoremError('internal', 'A text file was read before its bytes were checked'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return decoded.text;
}

/** `text` as the file's base64 bytes, in the encoding the file was read in; the given bytes when the text is unchanged. */
function rewriteTextFile(mimeType: string, data: string, text: string): string {
  const decoded = decodeTextFile(mimeType, data);
  if (decoded === null) {
    throw new TheoremError('internal', 'A text file was written before its bytes were checked'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (decoded.text === text) return data;
  const mark = decoded.bom
    ? (BOMS.find(([kind]) => kind === decoded.encoding.kind)?.[1] ?? [])
    : [];
  const body = encodeAs(decoded.encoding, text);
  const bytes = new Uint8Array(mark.length + body.length);
  bytes.set(mark);
  bytes.set(body, mark.length);
  return bytesToBase64(bytes);
}

/** A text file as the model reads it: its text as UTF-8, under a charset that says so, with a CSV's formula cells escaped. */
function modelTextFile(mimeType: string, data: string): { mimeType: string; data: string } {
  const decoded = decodeTextFile(mimeType, data);
  if (decoded === null) {
    throw new TheoremError('internal', 'A text file was read before its bytes were checked'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  // why: a charset with no table is read byte for byte by the guard, and by its own decoder for the model, which reads UTF-8.
  const read =
    decoded.encoding.kind === 'bytes'
      ? new TextDecoder(decoded.encoding.name).decode(base64ToBytes(data))
      : decoded.text;
  const text = mimeEssence(mimeType) === 'text/csv' ? sanitizeCsvText(read) : read;
  if (decoded.encoding.kind === 'utf-8' && !decoded.bom && text === decoded.text) {
    return { mimeType, data };
  }
  return { mimeType: utf8MimeType(mimeType), data: utf8Data(text) };
}

/** The MIME type with a charset it names said as UTF-8. */
function utf8MimeType(mimeType: string): string {
  return charsetOf(mimeType) === undefined ? mimeType : mimeType.replace(CHARSET, '$1utf-8');
}

function utf8Data(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** `sizeBytes` is absent for provider references, which carry no bytes. */
export interface AttachmentFacts {
  name?: string;
  mimeType: string;
  sizeBytes?: number;
}

/** An absent `accept` list means the channel takes nothing. */
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

/** The one attachment check: the kernel throws on it at ingress and the headless interface runs it before a send. */
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

const ISSUE_KEYS: Record<AttachmentValidationIssue['code'], LabelKey> = {
  mime_not_allowed: 'attachments.mime_not_allowed',
  too_many_files: 'attachments.too_many_files',
  too_many_of_kind: 'attachments.too_many_of_kind',
  file_too_large: 'attachments.file_too_large',
  turn_too_large: 'attachments.turn_too_large',
  attachments_not_accepted: 'attachments.not_accepted',
  voice_not_accepted: 'attachments.not_accepted',
  limits_unconfigured: 'attachments.limits_unconfigured',
};

/** The user-facing wording key and params for an attachment issue. */
function attachmentIssueCopy(issue: AttachmentValidationIssue): ErrorCopy {
  const params: LabelParams = {};
  for (const [key, value] of Object.entries(issue.params ?? {})) {
    if (value !== undefined) params[key] = value;
  }
  if (issue.fileName !== undefined) params.fileName = issue.fileName;
  return { key: ISSUE_KEYS[issue.code], params };
}

/** The user-facing text for an attachment issue. */
function attachmentIssueText(issue: AttachmentValidationIssue, labels?: LabelOverrides): string {
  const copy = attachmentIssueCopy(issue);
  return labelText(copy.key, copy.params, labels);
}

/** The error for a turn whose attachments were refused. */
function attachmentsRefused(issues: readonly AttachmentValidationIssue[]): TheoremError {
  return new TheoremError(
    'input',
    // labels-exempt: internal diagnostic; the user reads the copy lines
    `attachments refused: ${issues.map((issue) => issue.code).join(', ')}`,
    { copy: issues.map(attachmentIssueCopy) },
  );
}

/** The decoded size of inline base64 data; throws when it is not base64. */
function base64Bytes(data: string): number {
  if (!B64_BODY.test(data)) {
    // labels-exempt: developer-facing wire-format diagnostic, not product copy
    throw new TheoremError('request', 'attachment data must be base64');
  }
  return b64DecodedLen(data);
}

function factsOf(item: TurnBlob | TurnMediaRef): AttachmentFacts {
  const facts: AttachmentFacts = { mimeType: item.mimeType, name: item.name };
  if (isTurnMediaRef(item)) return facts;
  facts.sizeBytes = base64Bytes(item.data);
  return facts;
}

/** Provider references are checked for MIME and count; byte limits apply to inline blobs only. */
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

function sanitizeAttachment<T extends TurnBlob | TurnMediaRef>(blob: T, reader: BoundaryReader): T {
  if (isTurnMediaRef(blob)) {
    return blob;
  }
  const { mimeType, data } = blob;
  if (!isTextFile(mimeType)) {
    return blob;
  }
  const model = modelTextFile(mimeType, data);
  const text = textFileText(model.mimeType, model.data);
  const read = reader.read(text);
  return {
    ...blob,
    mimeType: model.mimeType,
    data: rewriteTextFile(model.mimeType, model.data, read),
  };
}

type TurnAttachments = Array<TurnBlob | TurnMediaRef>;

function hasTurnBlobs(attachments?: TurnAttachments, voice?: TurnBlob[]): boolean {
  return (attachments?.length ?? 0) > 0 || (voice?.length ?? 0) > 0;
}

/** Provider file references pass through unsanitized: the kernel has no bytes to scan. */
function sanitizeTurnBlobs(
  profile: Profile,
  attachments: Array<TurnBlob | TurnMediaRef> | undefined,
  voice: TurnBlob[] | undefined,
  at: { attachment: BoundaryReader; voice: BoundaryReader },
): { attachments?: Array<TurnBlob | TurnMediaRef>; voice?: TurnBlob[] } {
  assertTurnAttachments(profile, attachments, voice);
  return {
    attachments: attachments?.length
      ? attachments.map((blob) => sanitizeAttachment(blob, at.attachment))
      : attachments,
    voice: voice?.length ? voice.map((blob) => sanitizeAttachment(blob, at.voice)) : voice,
  };
}

export {
  assertTurnAttachments,
  attachmentIssueCopy,
  attachmentIssues,
  attachmentIssueText,
  attachmentsRefused,
  base64Bytes,
  isTextFile,
  isTextFileData,
  isTurnMediaRef,
  maxBytesForMime,
  modelTextFile,
  requireMediaLimits,
  resolveMediaLimits,
  rewriteTextFile,
  sanitizeCsvText,
  sanitizeTurnBlobs,
  textFileText,
};
