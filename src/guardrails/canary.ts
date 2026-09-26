import { mapStrings } from '../kernel/engine/tree.ts';
import type { TurnEvent } from '../kernel/types.ts';
import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { scanTextOf } from './serialize.ts';

const USER_OPEN = '<user_data>';
const USER_CLOSE = '</user_data>';
const CANARY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;
/** Literal placeholder substituted for a canary when an event is redacted. */
const OMIT_CANARY = '[omitted - canary]';
const FENCE = /<\/?user_data>/gi;

/** Creates a 128-bit, cryptographically random token for one turn's canary binding. */
function mintCanary(): string {
  const bytes = new Uint8Array(CANARY_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(HEX_RADIX).padStart(HEX_PAD, '0');
  }
  return hex;
}

function stripUserFences(text: string): string {
  return text.replaceAll(FENCE, '').trim();
}

/**
 * Removes pre-existing user-data fences, trims the input, and encloses the result
 * in the canonical user-data fence used by the guardrail prompt contract.
 */
function wrapUserData(text: string): string {
  return `${USER_OPEN}\n${stripUserFences(text)}\n${USER_CLOSE}`;
}

/**
 * Append the canary bind note to the host's system prompt.
 *
 * The note is the lexicon's `canary.bind_note`: the profile's `lexicon`, then
 * `overrideLexicon`, then the default. Every override is checked for the
 * `{canary}` placeholder when it is set — a note without the token binds nothing.
 */
function bindCanary(system: string, canary: string, lexicon?: LexiconOverrides): string {
  if (!canary) {
    return system;
  }
  const note = lexiconText('canary.bind_note', { canary }, lexicon);
  if (!system) {
    return note;
  }
  return `${system}\n\n${note}`;
}

/**
 * One character of text as the scan reads it: after Unicode compatibility
 * folding (`NFKC`: fullwidth and mathematical digits read as digits), with the
 * offsets `[at, to)` in the original text it came from.
 */
interface FoldedChar {
  char: string;
  at: number;
  to: number;
  /** A letter or digit: part of a word. */
  word: boolean;
}

/**
 * Lookalike letters the scan reads as the Latin letter they imitate, for the
 * letters a hex token and its transforms are written with (a–f, n–s).
 */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  ɑ: 'a',
  α: 'a',
  ь: 'b',
  в: 'b',
  β: 'b',
  с: 'c',
  ϲ: 'c',
  ԁ: 'd',
  е: 'e',
  ε: 'e',
  о: 'o',
  ο: 'o',
  օ: 'o',
  р: 'p',
  ρ: 'p',
  ԛ: 'q',
  ѕ: 's',
};

/** Spoken names the word reading maps to the character they spell. */
const SPELLED: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  alpha: 'a',
  alfa: 'a',
  bravo: 'b',
  charlie: 'c',
  delta: 'd',
  echo: 'e',
  foxtrot: 'f',
  november: 'n',
  oscar: 'o',
  papa: 'p',
  quebec: 'q',
  romeo: 'r',
  sierra: 's',
};

const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const ASCII_END = 0x80;

function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isWordChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < ASCII_END ? isAsciiAlphanumeric(code) : WORD_CHAR.test(char);
}

/** Standard base64 characters: letters, digits, `+`, `/`. */
function isBase64Char(char: string): boolean {
  const code = char.charCodeAt(0);
  return char === '+' || char === '/' || (code < ASCII_END && isAsciiAlphanumeric(code));
}

/** The last text folded, per case mode: every form of one scan reads the same text. */
const foldCache = new Map<boolean, { text: string; chars: FoldedChar[] }>();

function foldText(text: string, foldCase: boolean): FoldedChar[] {
  const cached = foldCache.get(foldCase);
  if (cached?.text === text) {
    return cached.chars;
  }
  const chars = foldChars(text, foldCase);
  foldCache.set(foldCase, { text, chars });
  return chars;
}

function foldChars(text: string, foldCase: boolean): FoldedChar[] {
  const out: FoldedChar[] = [];
  let at = 0;
  for (const point of text) {
    const to = at + point.length;
    const lower = foldCase ? point.toLowerCase() : point;
    const folded = point < '\u0080' ? lower : (CONFUSABLES[lower] ?? lower.normalize('NFKC'));
    for (const char of folded) {
      const read = foldCase ? char.toLowerCase() : char;
      out.push({ char: read, at, to, word: isWordChar(read) });
    }
    at = to;
  }
  return out;
}

/** The characters of `text` a form reads, with the offsets in `text` each came from. */
interface CanaryProjection {
  kept: string;
  at: number[];
  to: number[];
  /**
   * The word the text ends inside, which may still grow into another word
   * ("e" into "eight"): where it starts, how much of `kept` came before it,
   * and the characters it could still spell. The scan reads it as it stands;
   * the hold does not let it break an opening before it ends.
   */
  unfinished?: { at: number; settled: number; spells: string };
}

/**
 * The most text allowed between two characters of one leak. Further apart,
 * they are not read as one token, so an opening stops being held once this
 * much text follows it: the hold stays short however sparse the alphabet.
 */
const LEAK_GAP = 32;
/** Marks a gap wider than `LEAK_GAP` in a projection; no form's value contains it. */
const GAP = ' ';

function newProjection(): CanaryProjection {
  return { kept: '', at: [], to: [] };
}

function breakGap(projection: CanaryProjection, at: number): void {
  const last = projection.to.at(-1);
  if (last !== undefined && at - last > LEAK_GAP && !projection.kept.endsWith(GAP)) {
    projection.kept += GAP;
    projection.at.push(last);
    projection.to.push(last);
  }
}

/** Close a projection: an opening followed by more than `LEAK_GAP` of text is spent. */
function finish(projection: CanaryProjection, length: number): CanaryProjection {
  breakGap(projection, length);
  return projection;
}

function keep(projection: CanaryProjection, char: string, at: number, to: number): void {
  breakGap(projection, at);
  projection.kept += char;
  projection.at.push(at);
  projection.to.push(to);
}

/**
 * One shape a leaked canary is detected in, and how text is read for it. A
 * leak is any run of `min` consecutive characters of `value` in what the
 * reading keeps, so separators, case, and a truncated token do not hide it.
 */
interface CanaryLeakForm {
  value: string;
  min: number;
  project: (text: string) => CanaryProjection;
  /**
   * Characters a match's redaction grows over, up to one base64 group each
   * side: the groups the token shares with the text around it still carry
   * some of its bits.
   */
  edge?: RegExp;
}

/**
 * How many consecutive characters of a form count as a leak: 16 of the token
 * (64 bits), so a truncated or partly split token is still caught. A form
 * shorter than its run is matched whole.
 */
const TOKEN_LEAK_RUN = 16;
/** The same 64+ bits written as base64 (6 bits a character) or byte codes (2–3 digits a byte). */
const BASE64_LEAK_RUN = 20;
const BYTE_CODE_LEAK_RUN = 32;
const HEX_RADIX_OUT = 16;
const BASE64_EDGE = /^[A-Za-z0-9+/=_-]$/;
const BASE64_GROUP = 3;
const BASE64_GROUP_CHARS = 4;
const ROT13_SHIFT = 13;
const LATIN_LETTERS = 26;
const LOWER_A = 'a'.charCodeAt(0);

function rot13(text: string): string {
  return text.replace(/[a-z]/g, (char) =>
    String.fromCharCode(((char.charCodeAt(0) - LOWER_A + ROT13_SHIFT) % LATIN_LETTERS) + LOWER_A),
  );
}

/** Reads, case-folded, each character of `alphabet` wherever it stands. */
/** The last projection of each reading: forms with the same alphabet share it within a scan. */
const projectionCache = new Map<string, { text: string; projection: CanaryProjection }>();

function sharedReading(
  kind: string,
  alphabet: Set<string>,
  read: (text: string) => CanaryProjection,
): (text: string) => CanaryProjection {
  const key = `${kind}:${[...alphabet].sort().join('')}`;
  return (text) => {
    const cached = projectionCache.get(key);
    if (cached?.text === text) {
      return cached.projection;
    }
    const projection = read(text);
    projectionCache.set(key, { text, projection });
    return projection;
  };
}

function byCharacter(alphabet: Set<string>): (text: string) => CanaryProjection {
  return sharedReading('char', alphabet, (text) => {
    const projection = newProjection();
    for (const { char, at, to } of foldText(text, true)) {
      if (alphabet.has(char)) keep(projection, char, at, to);
    }
    return finish(projection, text.length);
  });
}

/**
 * Reads word by word: a word written only in `alphabet` counts in full, a
 * spoken name (`SPELLED`) counts as the character it spells, and any other
 * word is a separator. "3, then f" reads as "3f"; "zero one" as "01".
 */
/** The token characters a word cut off by the end of the text could still spell. */
function couldSpell(written: string, alphabet: Set<string>): string {
  return Object.entries(SPELLED)
    .filter(([name, char]) => name.startsWith(written) && alphabet.has(char))
    .map(([, char]) => char)
    .join('');
}

/** Where the opening of `form` at the end of `kept` starts, if any. */
function openingFrom(kept: string, at: number[], form: CanaryLeakForm): number | undefined {
  for (let size = Math.min(kept.length, form.value.length - 1); size > 0; size--) {
    if (kept.endsWith(form.value.slice(0, size))) {
      return at[kept.length - size];
    }
  }
  return undefined;
}

function byWord(alphabet: Set<string>): (text: string) => CanaryProjection {
  return sharedReading('word', alphabet, (text) => {
    const projection = newProjection();
    const chars = foldText(text, true);
    for (let start = 0; start < chars.length; ) {
      let end = start;
      while (end < chars.length && chars[end]?.word) end++;
      if (end === start) {
        start++;
        continue;
      }
      // A `0x` prefix marks a hex byte; the byte is the word.
      const hexByte =
        end - start > 2 && chars[start]?.char === '0' && chars[start + 1]?.char === 'x';
      const word = chars.slice(hexByte ? start + 2 : start, end);
      const written = word.map((c) => c.char).join('');
      if (end === chars.length) {
        breakGap(projection, word[0]?.at ?? 0);
        projection.unfinished = {
          at: chars[start]?.at ?? 0,
          settled: projection.kept.length,
          spells: couldSpell(written, alphabet),
        };
      }
      const spelled = SPELLED[written];
      if (spelled !== undefined && alphabet.has(spelled)) {
        keep(projection, spelled, word[0]?.at ?? 0, word.at(-1)?.to ?? 0);
      } else if (word.every((c) => alphabet.has(c.char))) {
        for (const { char, at, to } of word) keep(projection, char, at, to);
      }
      start = end;
    }
    return finish(projection, text.length);
  });
}

/** Reads base64 characters wherever they stand; every base64 form shares the reading. */
const readBase64 = sharedReading('base64', new Set(), (text) => {
  const projection = newProjection();
  for (const { char, at, to } of foldText(text, false)) {
    // URL-safe base64 reads as standard; padding is not part of the token.
    const standard = char === '-' ? '+' : char === '_' ? '/' : char;
    if (isBase64Char(standard)) keep(projection, standard, at, to);
  }
  return finish(projection, text.length);
});

/**
 * The base64 of the token at each of the three byte offsets it can start at
 * inside larger encoded text, trimmed to the groups made of token bytes only.
 */
function base64Cores(bytes: string): string[] {
  const cores: string[] = [];
  for (let offset = 0; offset < BASE64_GROUP; offset++) {
    const encoded = btoa('\0'.repeat(offset) + bytes);
    const first = Math.ceil(offset / BASE64_GROUP);
    const last = Math.floor((offset + bytes.length) / BASE64_GROUP);
    cores.push(encoded.slice(first * BASE64_GROUP_CHARS, last * BASE64_GROUP_CHARS));
  }
  return cores;
}

/** The bytes a hex token spells, as a binary string; `undefined` for any other token. */
function decodedHexBytes(literal: string): string | undefined {
  if (literal.length % HEX_PAD !== 0 || !/^[0-9a-f]+$/.test(literal)) {
    return undefined;
  }
  let bytes = '';
  for (let at = 0; at < literal.length; at += HEX_PAD) {
    bytes += String.fromCharCode(Number.parseInt(literal.slice(at, at + HEX_PAD), HEX_RADIX_OUT));
  }
  return bytes;
}

function leakRun(value: string, run: number): number {
  return Math.min(value.length, run);
}

let formsCache: { canary: string; forms: CanaryLeakForm[] } | undefined;

/**
 * Every form a leaked canary is detected in: the token itself, reversed, and
 * in ROT13 — each read character by character and word by word — its
 * characters as hex or decimal codes, and its base64 at every byte offset; a
 * hex token also as the bytes it spells, in decimal or base64. The token carries no fixed prefix, so no form
 * depends on a marker the model could drop or split off.
 */
function canaryLeakForms(canary: string): CanaryLeakForm[] {
  if (formsCache?.canary === canary) {
    return formsCache.forms;
  }
  const literal = canary.toLowerCase();
  const forms: CanaryLeakForm[] = [];
  const seen = new Set<string>();
  // A token that reads the same reversed, or has no letters to rotate, is already covered.
  for (const value of [literal, [...literal].reverse().join(''), rot13(literal)]) {
    if (seen.has(value)) continue;
    seen.add(value);
    const alphabet = new Set(value);
    const min = leakRun(value, TOKEN_LEAK_RUN);
    forms.push({ value, min, project: byCharacter(alphabet) });
    forms.push({ value, min, project: byWord(alphabet) });
  }
  // The token's characters as numbers: hex (xxd, %-encoding) and decimal (char codes,
  // `&#…;`); a hex token also as the bytes it spells, in decimal.
  const codes = [...canary].map((char) => char.charCodeAt(0));
  const decoded = decodedHexBytes(literal);
  for (const value of [
    codes.map((code) => code.toString(HEX_RADIX_OUT).padStart(HEX_PAD, '0')).join(''),
    codes.join(''),
    ...(decoded ? [[...decoded].map((char) => char.charCodeAt(0)).join('')] : []),
  ]) {
    if (seen.has(value)) continue;
    seen.add(value);
    forms.push({
      value,
      min: leakRun(value, BYTE_CODE_LEAK_RUN),
      project: byCharacter(new Set(value)),
    });
  }
  try {
    for (const value of [...base64Cores(canary), ...(decoded ? base64Cores(decoded) : [])]) {
      if (value && !seen.has(value)) {
        seen.add(value);
        forms.push({
          value,
          min: leakRun(value, BASE64_LEAK_RUN),
          project: readBase64,
          edge: BASE64_EDGE,
        });
      }
    }
  } catch {
    /* a host canary outside Latin-1 has no base64 form */
  }
  formsCache = { canary, forms };
  return forms;
}

/** Every `[start, end)` in `kept` holding `min` or more consecutive characters of `value`. */
function leakRunsIn(kept: string, form: CanaryLeakForm): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let from = 0; from + form.min <= form.value.length; from++) {
    const piece = form.value.slice(from, from + form.min);
    for (let found = kept.indexOf(piece); found >= 0; found = kept.indexOf(piece, found + 1)) {
      runs.push([found, found + form.min]);
    }
  }
  return runs;
}

function widen(text: string, [start, end]: [number, number], edge?: RegExp): [number, number] {
  if (!edge) {
    return [start, end];
  }
  let from = start;
  while (from > 0 && start - from < BASE64_GROUP_CHARS && edge.test(text.charAt(from - 1))) from--;
  let to = end;
  while (to < text.length && to - end < BASE64_GROUP_CHARS && edge.test(text.charAt(to))) to++;
  return [from, to];
}

/** Offsets `[start, end)` of `text` covering each leak, ordered by start. */
function canaryLeakRanges(text: string, canary: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const form of canaryLeakForms(canary)) {
    const { kept, at, to } = form.project(text);
    for (const [start, end] of leakRunsIn(kept, form)) {
      ranges.push(widen(text, [at[start] ?? 0, to[end - 1] ?? 0], form.edge));
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Returns whether text contains a canary in any detected leak form
 * (`canaryLeakForms`). This is leak detection, not general-purpose
 * encoded-data detection.
 */
function scanTextForCanaryLeak(text: string, canary: string): boolean {
  if (!text || !canary) {
    return false;
  }
  return canaryLeakForms(canary).some(
    (form) => leakRunsIn(form.project(text).kept, form).length > 0,
  );
}

/**
 * Offset from which `text` must stay held: the earliest point where what
 * follows is the start of a leak form, and so could still grow into a leak.
 * Everything before it is safe to release whatever arrives next.
 */
function canaryHoldFrom(text: string, canary: string): number {
  let from = text.length;
  if (!canary) {
    return from;
  }
  for (const form of canaryLeakForms(canary)) {
    const { kept, at, unfinished } = form.project(text);
    const openings = [openingFrom(kept, at, form)];
    if (unfinished) {
      // An opening before the last word stays held until that word ends, whatever it reads as now.
      openings.push(openingFrom(kept.slice(0, unfinished.settled), at, form));
      if (unfinished.spells.includes(form.value.charAt(0))) {
        openings.push(unfinished.at);
      }
    }
    for (const opening of openings) {
      if (opening !== undefined) from = Math.min(from, opening);
    }
  }
  return from;
}

/** The longest name in `SPELLED`: the most text one character of a leak can cover. */
const LONGEST_SPELLED = Math.max(...Object.keys(SPELLED).map((word) => word.length));
/**
 * The most text one leak run can cover: at most `BYTE_CODE_LEAK_RUN`
 * characters (the longest run), each within `LEAK_GAP` of the next and at
 * most a spelled word long.
 */
const CANARY_SCAN_LOOKBACK = BYTE_CODE_LEAK_RUN * (LEAK_GAP + LONGEST_SPELLED);
const WORD_BOUNDARY_SEARCH = 64;

/**
 * Where a scan of `text` must start when everything before `from` was
 * already scanned clean: a leak that ends past `from` starts no more than
 * `CANARY_SCAN_LOOKBACK` before it. The start moves to the next space, so no
 * word is read cut in half; a scan that reads this far back reads the same
 * leaks as one over the whole text.
 */
function canaryScanFrom(text: string, from: number): number {
  const start = from - CANARY_SCAN_LOOKBACK - WORD_BOUNDARY_SEARCH;
  if (start <= 0) {
    return 0;
  }
  const space = text.slice(start, start + WORD_BOUNDARY_SEARCH).search(/\s/);
  return space < 0 ? start : start + space;
}

/**
 * The tail of a finished window that could still open a leak: what the next
 * window of the same canary scans in front of its own text. Carried forward
 * as it grows, it bounds the carry to one token's length.
 */
function canaryCarry(text: string, canary: string): string {
  return text.slice(canaryHoldFrom(text, canary));
}

/** `text` with every detected canary leak replaced by `OMIT_CANARY`. */
function redactCanaryText(text: string, canary: string): string {
  if (!text || !canary) {
    return text;
  }
  let out = '';
  let from = 0;
  for (const [start, end] of canaryLeakRanges(text, canary)) {
    if (start >= from) {
      out += `${text.slice(from, start)}${OMIT_CANARY}`;
    }
    from = Math.max(from, end);
  }
  return out + text.slice(from);
}

/**
 * Thinking is not guarded output: a host that shows `thought` events accepts
 * what they contain, and a thinking model restates its system prompt as it
 * reasons. Every outbound gate reads this before scanning.
 */
function isGuardedOutput(event: TurnEvent): boolean {
  return event.type !== 'thought';
}

/**
 * Checks the content-bearing fields currently emitted by a turn event, including
 * text, errors, structured payloads, tool data, evidence, and session metadata.
 * Unguarded output (`isGuardedOutput`) never carries a leak.
 */
function eventHasCanary(event: TurnEvent, canary: string): boolean {
  if (!canary || !isGuardedOutput(event)) {
    return false;
  }
  if (event.text && scanTextForCanaryLeak(event.text, canary)) {
    return true;
  }
  if (event.error && scanTextForCanaryLeak(event.error, canary)) {
    return true;
  }
  if (
    event.structured !== undefined &&
    scanTextForCanaryLeak(scanTextOf(event.structured), canary)
  ) {
    return true;
  }
  if (event.tool !== undefined && scanTextForCanaryLeak(scanTextOf(event.tool), canary)) {
    return true;
  }
  if (event.grounding !== undefined && scanTextForCanaryLeak(scanTextOf(event.grounding), canary)) {
    return true;
  }
  if (event.evidence !== undefined && scanTextForCanaryLeak(scanTextOf(event.evidence), canary)) {
    return true;
  }
  if (event.session !== undefined && scanTextForCanaryLeak(scanTextOf(event.session), canary)) {
    return true;
  }
  if (
    event.sessionResumptionHandle &&
    scanTextForCanaryLeak(event.sessionResumptionHandle, canary)
  ) {
    return true;
  }
  return false;
}

/** Result of scanning one streamed window: either a leak or the prefix safe to emit. */
type CanaryGateResult = { leak: true } | { leak: false; emit: string };

/**
 * Incremental canary scanner that retains the tail that could start a leak
 * (`canaryHoldFrom`), so a leak split across adjacent stream chunks is not
 * released prematurely.
 */
interface CanaryStreamGate {
  process: (fragment: string) => CanaryGateResult;
  flush: () => CanaryGateResult;
}

/** Creates an incremental scanner for one canary token; call `flush` at stream end. */
function createCanaryStreamGate(canary: string): CanaryStreamGate {
  let pending = '';
  /** Released text a run could still continue from (`canaryScanFrom`), read but never re-released. */
  let released = '';

  function leaks(window: string): boolean {
    const text = released + window;
    return scanTextForCanaryLeak(text.slice(canaryScanFrom(text, released.length)), canary);
  }

  function step(window: string): CanaryGateResult {
    if (leaks(window)) {
      return { leak: true };
    }
    const safeEnd = canaryHoldFrom(window, canary);
    const emit = window.slice(0, safeEnd);
    pending = window.slice(safeEnd);
    released += emit;
    released = released.slice(canaryScanFrom(released, released.length));
    return { leak: false, emit };
  }

  return {
    process(fragment: string): CanaryGateResult {
      if (!fragment) {
        return { leak: false, emit: '' };
      }
      return step(pending + fragment);
    },
    flush(): CanaryGateResult {
      if (leaks(pending)) {
        return { leak: true };
      }
      const emit = pending;
      pending = '';
      return { leak: false, emit };
    },
  };
}

/**
 * The reply as it streams: text deltas, and the transcript of spoken output
 * (Live `output_transcription` evidence). The one stream the outbound gates
 * scan progressively; everything else is scanned whole per event.
 */
function isStreamedCanaryEvent(event: TurnEvent): boolean {
  return (
    event.type === 'text' ||
    (event.type === 'evidence' && event.evidence?.kind === 'output_transcription')
  );
}

/** Replaces every detected canary leak in every string field of an event. */
function redactCanary(event: TurnEvent, canary: string): TurnEvent {
  const next = mapStrings(event, (text) => redactCanaryText(text, canary));
  if (next && typeof next === 'object') {
    return next as TurnEvent;
  }
  return event;
}

export type { CanaryGateResult, CanaryStreamGate };
export {
  bindCanary,
  canaryCarry,
  canaryHoldFrom,
  canaryScanFrom,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  redactCanaryText,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
};
