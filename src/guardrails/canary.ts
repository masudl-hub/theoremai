import { mapStrings } from '../kernel/engine/tree.ts';
import {
  type ProviderEvent,
  type TurnEvent,
  type TurnEventOf,
  turnEventSchema,
} from '../kernel/turn-events.ts';
import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { promptEchoScanFrom, scanTextForPromptEcho } from './prompt-echo.ts';
import { scanTextOf } from './serialize.ts';

const USER_OPEN = '<user_data>';
const USER_CLOSE = '</user_data>';
const CANARY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;
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

/** Appends the lexicon's `user_data.note`, which tells the model what `wrapUserData`'s tags mean. */
function bindUserDataNote(system: string, lexicon?: LexiconOverrides): string {
  const note = lexiconText('user_data.note', {}, lexicon);
  if (!note) return system;
  return system ? `${system}\n\n${note}` : note;
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

/** The longest name in `SPELLED`: the most text one character of a leak can cover. */
const LONGEST_SPELLED = Math.max(...Object.keys(SPELLED).map((word) => word.length));

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

/** The characters of `text` as the scan reads them; `offset` is where `text` starts in the stream. */
function foldChars(text: string, foldCase: boolean, offset = 0): FoldedChar[] {
  const out: FoldedChar[] = [];
  let at = offset;
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
  reading: CanaryReading;
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

/**
 * One way of reading text for a leak, fed the text as it streams. Every
 * character it has read settles into `projection`, except the word the text
 * ends inside, which the next characters may still change ("e" into "eight").
 */
interface CanaryReader {
  projection: CanaryProjection;
  read: (chars: FoldedChar[]) => void;
  /** What the open word adds to `projection.kept` as it stands; the projection is left as is. */
  openKept: () => string;
  /** The projection of the whole text, `length` long, the open word read as it ends it. Ends the reader. */
  close: (length: number) => CanaryProjection;
  /**
   * The shortest `projection.kept` has been since the last call: a word
   * read as part of a leak and then broken takes its characters back out.
   */
  shrunkTo: () => number;
  /**
   * Drops all but the last `length` characters of `projection.kept`, and
   * keeps any an open word could still be taken back to; returns how many it
   * dropped.
   */
  trim: (length: number) => number;
}

function trimProjection(projection: CanaryProjection, length: number): number {
  const dropped = Math.max(0, projection.kept.length - length);
  if (dropped > 0) {
    projection.kept = projection.kept.slice(dropped);
    projection.at.splice(0, dropped);
    projection.to.splice(0, dropped);
  }
  return dropped;
}

/** A reading forms share: one projection of a text serves every form with the same `key`. */
interface CanaryReading {
  key: string;
  /** Whether the reading folds case (every reading but base64). */
  foldCase: boolean;
  open: () => CanaryReader;
}

/** A reader whose every character settles as it is read. */
function settledReader(accept: (char: string) => string | undefined): CanaryReader {
  const projection = newProjection();
  return {
    projection,
    read(chars) {
      for (const { char, at, to } of chars) {
        const kept = accept(char);
        if (kept !== undefined) keep(projection, kept, at, to);
      }
    },
    openKept: () => '',
    close: (length) => finish(projection, length),
    shrunkTo: () => projection.kept.length,
    trim: (length) => trimProjection(projection, length),
  };
}

/** Reads, case-folded, each character of `alphabet` wherever it stands. */
function byCharacter(alphabet: Set<string>): CanaryReading {
  return {
    key: `char:${[...alphabet].sort().join('')}`,
    foldCase: true,
    open: () => settledReader((char) => (alphabet.has(char) ? char : undefined)),
  };
}

/** The last projection of each reading: forms with the same reading share it within a scan. */
const projectionCache = new Map<string, { text: string; projection: CanaryProjection }>();

/** `text` as `reading` reads it, whole. */
function project(reading: CanaryReading, text: string): CanaryProjection {
  const cached = projectionCache.get(reading.key);
  if (cached?.text === text) {
    return cached.projection;
  }
  const reader = reading.open();
  reader.read(foldText(text, reading.foldCase));
  const projection = reader.close(text.length);
  projectionCache.set(reading.key, { text, projection });
  return projection;
}

/** The token characters a word cut off by the end of the text could still spell. */
function couldSpell(written: string, alphabet: Set<string>): string {
  return Object.entries(SPELLED)
    .filter(([name, char]) => name.startsWith(written) && alphabet.has(char))
    .map(([, char]) => char)
    .join('');
}

/**
 * The shortest opening of a leak the hold keeps back. Shorter openings go out,
 * so ordinary text is not held on every letter a token could start with; the
 * cost is that a blocked leak shows the host at most this many characters less
 * one — 3 of a 16-character run, where any run under 16 already passes.
 */
const CANARY_OPENING_MIN = 4;

/** `CANARY_OPENING_MIN`, scaled down for a form whose leak run is short. */
function openingMin(form: CanaryLeakForm): number {
  return Math.min(CANARY_OPENING_MIN, Math.ceil(form.min / CANARY_OPENING_MIN));
}

/** How short an opening a caller keeps: the hold's minimum, or any opening at all. */
type OpeningMin = (form: CanaryLeakForm) => number;

const ANY_OPENING: OpeningMin = () => 1;

/** Where the opening of `form` at the end of `kept` starts, if one is at least `shortest` long. */
function openingFrom(
  kept: string,
  at: number[],
  form: CanaryLeakForm,
  shortest: number,
): number | undefined {
  for (let size = Math.min(kept.length, form.value.length - 1); size >= shortest; size--) {
    if (kept.endsWith(form.value.slice(0, size))) {
      return at[kept.length - size];
    }
  }
  return undefined;
}

/**
 * A word longer than this can be neither a spoken name nor one behind `0x`:
 * how it reads is settled but for whether it stays in the alphabet.
 */
const LONGEST_WORD_READ = LONGEST_SPELLED + HEX_PAD;

/** Whether `chars`, a whole word, starts with a `0x` byte prefix; the byte is the word. */
function isHexByte(chars: FoldedChar[]): boolean {
  return chars.length > HEX_PAD && chars[0]?.char === '0' && chars[1]?.char === 'x';
}

/**
 * Reads one word into `projection`; `open` when the text ends inside it, so
 * it may still grow into another word.
 */
function readWord(
  projection: CanaryProjection,
  chars: FoldedChar[],
  alphabet: Set<string>,
  open: boolean,
): void {
  const word = isHexByte(chars) ? chars.slice(HEX_PAD) : chars;
  const written = word.map((c) => c.char).join('');
  if (open) {
    breakGap(projection, word[0]?.at ?? 0);
    projection.unfinished = {
      at: chars[0]?.at ?? 0,
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
}

/**
 * Reads word by word: a word written only in `alphabet` counts in full, a
 * spoken name (`SPELLED`) counts as the character it spells, and any other
 * word is a separator. "3, then f" reads as "3f"; "zero one" as "01".
 *
 * A word longer than `LONGEST_WORD_READ` is read as it streams: its
 * characters are kept as they come while every one is in the alphabet, and
 * taken back out if one is not. However long the word, each character is
 * read once.
 */
function byWord(alphabet: Set<string>): CanaryReading {
  return {
    key: `word:${[...alphabet].sort().join('')}`,
    foldCase: true,
    open: () => wordReader(alphabet),
  };
}

function wordReader(alphabet: Set<string>): CanaryReader {
  const projection = newProjection();
  /** The open word. */
  let word: FoldedChar[] = [];
  /** A long open word: how long `kept` was before it, and after the gap in front of it. */
  let long: { before: number; after: number; broken: boolean } | undefined;
  let shrunk = 0;

  function truncate(length: number): void {
    projection.kept = projection.kept.slice(0, length);
    projection.at.length = length;
    projection.to.length = length;
    shrunk = Math.min(shrunk, length);
  }

  /** The open word just grew past `LONGEST_WORD_READ`: keep it while it is in the alphabet. */
  function lengthen(): void {
    const body = isHexByte(word) ? word.slice(HEX_PAD) : word;
    const before = projection.kept.length;
    breakGap(projection, body[0]?.at ?? 0);
    long = { before, after: projection.kept.length, broken: false };
    if (body.every((c) => alphabet.has(c.char))) {
      for (const { char, at, to } of body) keep(projection, char, at, to);
    } else {
      breakWord();
    }
  }

  /** The long open word has a character outside the alphabet: it is a separator. */
  function breakWord(): void {
    if (long && !long.broken) {
      truncate(Math.max(0, long.before));
      long.broken = true;
    }
  }

  function grow(char: FoldedChar): void {
    word.push(char);
    if (word.length === LONGEST_WORD_READ + 1) {
      lengthen();
    } else if (long && !long.broken) {
      if (alphabet.has(char.char)) keep(projection, char.char, char.at, char.to);
      else breakWord();
    }
  }

  function settle(): void {
    // A long word's characters are already kept, or already taken back out.
    if (!long) readWord(projection, word, alphabet, false);
    word = [];
    long = undefined;
  }

  return {
    projection,
    read(chars) {
      for (const char of chars) {
        if (char.word) grow(char);
        else if (word.length > 0) settle();
      }
    },
    openKept() {
      if (word.length === 0 || long) {
        return '';
      }
      // Only `kept` is read back: the gap check needs just the last offset.
      const view = { kept: projection.kept, at: [], to: projection.to.slice(-1) };
      readWord(view, word, alphabet, true);
      return view.kept.slice(projection.kept.length);
    },
    close(length) {
      if (word.length > 0 && !long) {
        readWord(projection, word, alphabet, true);
      } else if (long) {
        const body = isHexByte(word) ? word.slice(HEX_PAD) : word;
        breakGap(projection, body[0]?.at ?? 0);
        projection.unfinished = {
          at: word[0]?.at ?? 0,
          settled: long.broken ? projection.kept.length : long.after,
          spells: '',
        };
      }
      return finish(projection, length);
    },
    shrunkTo() {
      const least = shrunk;
      shrunk = projection.kept.length;
      return least;
    },
    trim(length) {
      // A long word still kept may yet be taken back out, leaving what came
      // before it to continue a run: keep `length` characters in front of it.
      // Once its text spans more than `LEAK_GAP`, nothing before it can join a
      // run after it, so that can go too. Its text, not what it folds to: a
      // ligature keeps two characters for one.
      const kept = long && !long.broken ? long : undefined;
      const span = (word.at(-1)?.to ?? 0) - (word[0]?.at ?? 0);
      const shallow = kept && span <= LEAK_GAP;
      const dropped = trimProjection(
        projection,
        shallow ? projection.kept.length - kept.before + length : length,
      );
      if (kept) {
        kept.before -= dropped;
        kept.after -= dropped;
      }
      shrunk -= dropped;
      return dropped;
    },
  };
}

/** Reads base64 characters wherever they stand; every base64 form shares the reading. */
const readBase64: CanaryReading = {
  key: 'base64',
  foldCase: false,
  // URL-safe base64 reads as standard; padding is not part of the token.
  open: () =>
    settledReader((char) => {
      const standard = char === '-' ? '+' : char === '_' ? '/' : char;
      return isBase64Char(standard) ? standard : undefined;
    }),
};

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
    forms.push({ value, min, reading: byCharacter(alphabet) });
    forms.push({ value, min, reading: byWord(alphabet) });
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
      reading: byCharacter(new Set(value)),
    });
  }
  try {
    for (const value of [...base64Cores(canary), ...(decoded ? base64Cores(decoded) : [])]) {
      if (value && !seen.has(value)) {
        seen.add(value);
        forms.push({
          value,
          min: leakRun(value, BASE64_LEAK_RUN),
          reading: readBase64,
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
    const { kept, at, to } = project(form.reading, text);
    for (const [start, end] of leakRunsIn(kept, form)) {
      ranges.push(widen(text, [at[start] ?? 0, to[end - 1] ?? 0], form.edge));
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Leak detection over `canaryLeakForms` only, not general-purpose encoded-data detection. */
function scanTextForCanaryLeak(text: string, canary: string): boolean {
  if (!text || !canary) {
    return false;
  }
  return canaryLeakForms(canary).some(
    (form) => leakRunsIn(project(form.reading, text).kept, form).length > 0,
  );
}

/**
 * Offset from which `text` must stay held: the earliest point where what
 * follows is an opening of a leak form at least `CANARY_OPENING_MIN` long,
 * and so could still grow into a leak. A shorter opening is released; the
 * scan still reads it with what follows, so the leak it grows into is caught.
 */
function canaryHoldFrom(text: string, canary: string): number {
  return leakOpeningFrom(text, canary, openingMin);
}

/** Where the earliest opening of any leak form at least `minimum(form)` long starts in `text`. */
function leakOpeningFrom(text: string, canary: string, minimum: OpeningMin): number {
  let from = text.length;
  if (!canary) {
    return from;
  }
  for (const form of canaryLeakForms(canary)) {
    const { kept, at, unfinished } = project(form.reading, text);
    const shortest = minimum(form);
    const openings = [openingFrom(kept, at, form, shortest)];
    if (unfinished) {
      // An opening before the last word stays held until that word ends, whatever it reads as now.
      const settled = kept.slice(0, unfinished.settled);
      openings.push(openingFrom(settled, at, form, shortest));
      // The last word may still grow into a spelled character that makes one long enough.
      const grown = [...at.slice(0, unfinished.settled), unfinished.at];
      for (const char of unfinished.spells) {
        openings.push(openingFrom(settled + char, grown, form, shortest));
      }
    }
    for (const opening of openings) {
      if (opening !== undefined) from = Math.min(from, opening);
    }
  }
  return from;
}

/** Settled characters of a reading the stream scan keeps: every leak run is shorter. */
const SCAN_KEPT = BYTE_CODE_LEAK_RUN;
/** How long a reading's settled characters grow before the stream scan drops all but `SCAN_KEPT`. */
const SCAN_TRIM_AT = 8 * SCAN_KEPT;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

/**
 * Scans a stream for a canary leak as it arrives, reading each character
 * once: every reading keeps its projection of the stream so far and extends
 * it with the new text, and only runs that end in what the new text added
 * are checked. It reads the same leaks as `scanTextForCanaryLeak` over the
 * whole stream, in time proportional to the stream's length.
 */
interface CanaryScanner {
  /** Reads the next text of the stream; true once the stream holds a leak. */
  push: (text: string) => boolean;
}

/** One reading of the stream and the forms read in it; runs ending before `checked` are clean. */
interface StreamReading {
  reader: CanaryReader;
  foldCase: boolean;
  forms: CanaryLeakForm[];
  checked: number;
}

function createCanaryScanner(canary: string): CanaryScanner {
  const readings = new Map<string, StreamReading>();
  for (const form of canary ? canaryLeakForms(canary) : []) {
    const known = readings.get(form.reading.key);
    if (known) known.forms.push(form);
    else {
      readings.set(form.reading.key, {
        reader: form.reading.open(),
        foldCase: form.reading.foldCase,
        forms: [form],
        checked: 0,
      });
    }
  }
  let offset = 0;
  /** A high surrogate the last text ended on, read with the low one that follows. */
  let split = '';
  let leaked = false;

  function check(reading: StreamReading): boolean {
    const { reader } = reading;
    // Runs ending before `checked` were read clean; a broken word may have moved it back.
    const checked = Math.min(reading.checked, reader.shrunkTo());
    const kept = reader.projection.kept + reader.openKept();
    const found = reading.forms.some(
      (form) => leakRunsIn(kept.slice(Math.max(0, checked - form.min + 1)), form).length > 0,
    );
    reading.checked = reader.projection.kept.length;
    if (reading.checked > SCAN_TRIM_AT) reading.checked -= reader.trim(SCAN_KEPT);
    return found;
  }

  return {
    push(fragment) {
      if (leaked || !fragment) {
        return leaked;
      }
      let text = split + fragment;
      const last = text.charCodeAt(text.length - 1);
      split = last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? text.slice(-1) : '';
      text = text.slice(0, text.length - split.length);
      const folded = new Map<boolean, FoldedChar[]>();
      for (const reading of readings.values()) {
        let chars = folded.get(reading.foldCase);
        if (!chars) {
          chars = foldChars(text, reading.foldCase, offset);
          folded.set(reading.foldCase, chars);
        }
        reading.reader.read(chars);
        if (check(reading)) leaked = true;
      }
      offset += text.length;
      return leaked;
    },
  };
}

/**
 * The tail of a finished window that could still open a leak: what the next
 * window of the same canary scans in front of its own text. Carried forward
 * as it grows, it bounds the carry to one token's length. Unlike the hold it
 * keeps openings of any length: a leak split across windows is still one run.
 */
function canaryCarry(text: string, canary: string): string {
  return text.slice(leakOpeningFrom(text, canary, ANY_OPENING));
}

/**
 * What the next window of the same turn or session scans in front of its own:
 * a possible canary opening, and the words a prompt echo could continue from.
 */
function promptLeakCarry(text: string, canary: string, system?: string): string {
  const canaryTail = text.length - canaryCarry(text, canary).length;
  const from = system ? Math.min(canaryTail, promptEchoScanFrom(text, text.length)) : canaryTail;
  return text.slice(from);
}

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
 * Nothing in a thought stops the turn: `thought-guard.ts` omits what in it
 * leaks. Every outbound gate reads this before scanning.
 */
function isGuardedOutput(event: ProviderEvent): boolean {
  return event.type !== 'thought';
}

/**
 * What of an event reaches the host as content, field by field: the one list
 * every canary and prompt-leak scan reads. Builder-only fields
 * (`errorInternal`), counts, identities, and media bytes are not content.
 */
function hostContentOf(event: ProviderEvent): unknown[] {
  switch (event.type) {
    case 'text':
    case 'thought':
      return [event.text];
    case 'structured':
      return [event.structured];
    case 'grounding':
      return [event.grounding];
    case 'citation':
      return [event.sources];
    case 'compaction':
      return [event.summary];
    case 'evidence':
      return [event.evidence, event.text, event.sessionResumptionHandle];
    case 'session':
      return [event.session];
    case 'tool':
      return [event.tool];
    case 'error':
      return [event.error, event.errorCopy];
    case 'media':
    case 'tokens':
    case 'guardrail':
    case 'stage':
    case 'done':
    case 'response':
      return [];
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/**
 * The text of each field of an event's host content (`hostContentOf`), one
 * string per field. Unguarded output (`isGuardedOutput`) carries none.
 */
function guardedEventTexts(event: ProviderEvent): string[] {
  if (!isGuardedOutput(event)) {
    return [];
  }
  return hostContentOf(event)
    .map((field) => scanTextOf(field))
    .filter((text) => text !== '');
}

/**
 * Whether any field of an event's host content (`guardedEventTexts`) carries
 * a leak. Unguarded output (`isGuardedOutput`) never carries one.
 */
function eventHasCanary(event: ProviderEvent, canary: string): boolean {
  if (!canary) {
    return false;
  }
  return guardedEventTexts(event).some((text) => scanTextForCanaryLeak(text, canary));
}

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

/**
 * Call `flush` at stream end to release the held tail. With `system`, a reply
 * echoing the system prompt (`scanTextForPromptEcho`) is a leak too.
 */
function createCanaryStreamGate(canary: string, system?: string): CanaryStreamGate {
  const scanner = createCanaryScanner(canary);
  let pending = '';
  /** Released text a prompt echo could still continue from, read but never re-released. */
  let released = '';

  /**
   * Whether the stream holds a leak once `fragment` arrives, `window` being
   * the unreleased text it ends. The canary scan reads each character once;
   * the echo check rereads its own short lookback.
   */
  function leaks(fragment: string, window: string): boolean {
    const text = released + window;
    return (
      scanner.push(fragment) ||
      (system !== undefined &&
        scanTextForPromptEcho(text.slice(promptEchoScanFrom(text, released.length)), system))
    );
  }

  function step(fragment: string): CanaryGateResult {
    const window = pending + fragment;
    if (leaks(fragment, window)) {
      return { leak: true };
    }
    const safeEnd = canaryHoldFrom(window, canary);
    const emit = window.slice(0, safeEnd);
    pending = window.slice(safeEnd);
    released += emit;
    released = system ? released.slice(promptEchoScanFrom(released, released.length)) : '';
    return { leak: false, emit };
  }

  return {
    process(fragment: string): CanaryGateResult {
      if (!fragment) {
        return { leak: false, emit: '' };
      }
      return step(fragment);
    },
    flush(): CanaryGateResult {
      if (leaks('', pending)) {
        return { leak: true };
      }
      const emit = pending;
      pending = '';
      return { leak: false, emit };
    },
  };
}

type StreamedReplyEvent = TurnEventOf<'text' | 'evidence'>;

/**
 * The reply as it streams: text deltas, and the transcript of spoken output
 * (Live `output_transcription` evidence). The one stream the outbound gates
 * scan progressively; everything else is scanned whole per event.
 */
function isStreamedCanaryEvent(event: ProviderEvent): event is StreamedReplyEvent {
  return (
    event.type === 'text' ||
    (event.type === 'evidence' && event.evidence.kind === 'output_transcription')
  );
}

function redactCanary(event: TurnEvent, canary: string): TurnEvent {
  // Replacing strings keeps the event's shape; the parse re-types it.
  return turnEventSchema.parse(mapStrings(event, (text) => redactCanaryText(text, canary)));
}

export type { CanaryGateResult, CanaryScanner, CanaryStreamGate, StreamedReplyEvent };
export {
  bindCanary,
  bindUserDataNote,
  canaryHoldFrom,
  canaryLeakRanges,
  createCanaryScanner,
  createCanaryStreamGate,
  eventHasCanary,
  guardedEventTexts,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  promptLeakCarry,
  redactCanary,
  redactCanaryText,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
};
