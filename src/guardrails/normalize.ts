/**
 * Unicode normalization for injection detection preprocessing.
 *
 * Strips invisible characters, normalizes homoglyphs, fullwidth, math
 * variants, and Unicode spaces so regex-based injection patterns can
 * match evasion attempts that use visually similar substitutions.
 *
 * @module
 */

const STRIP_CODES: number[] = [
  0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x034f, 0x061c, 0x180e, 0x2066, 0x2067, 0x2068, 0x2069,
];

const STRIP_SET = new Set(STRIP_CODES);

const SPACE_CODES: number[] = [
  0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x202f, 0x205f, 0x3000,
];

const SPACE_SET = new Set(SPACE_CODES);

const HOMOGLYPH_MAP = new Map<number, string>([
  [0x0430, 'a'],
  [0x0441, 'c'],
  [0x0435, 'e'],
  [0x0456, 'i'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0455, 's'],
  [0x0443, 'y'],
  [0x0445, 'x'],
  [0x043a, 'k'],
  [0x043d, 'h'],
  [0x0410, 'A'],
  [0x0412, 'B'],
  [0x0415, 'E'],
  [0x041d, 'H'],
  [0x041e, 'O'],
  [0x041a, 'K'],
  [0x041c, 'M'],
  [0x0420, 'P'],
  [0x0421, 'C'],
  [0x0422, 'T'],
  [0x0425, 'X'],
  [0x03b1, 'a'],
  [0x03b5, 'e'],
  [0x03b9, 'i'],
  [0x03bf, 'o'],
  [0x03c1, 'p'],
  [0x2071, 'i'],
  [0x207f, 'n'],
  [0x1d43, 'a'],
  [0x1d47, 'b'],
  [0x1d48, 'd'],
  [0x1d49, 'e'],
  [0x1d4d, 'g'],
  [0x1d4f, 'k'],
  [0x1d50, 'm'],
  [0x1d52, 'o'],
  [0x1d56, 'p'],
  [0x1d57, 't'],
  [0x1d58, 'u'],
  [0x1d5b, 'v'],
]);

const FULLWIDTH_LO = 0xff01;
const FULLWIDTH_HI = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;

const COMBINING_LO = 0x0300;
const COMBINING_HI = 0x036f;

const MATH_ALPHA: [number, number][] = [
  [0x1d400, 0x1d41a],
  [0x1d434, 0x1d44e],
  [0x1d468, 0x1d482],
  [0x1d49c, 0x1d4b6],
  [0x1d4d0, 0x1d4ea],
  [0x1d504, 0x1d51e],
  [0x1d538, 0x1d552],
  [0x1d56c, 0x1d586],
  [0x1d5a0, 0x1d5ba],
  [0x1d5d4, 0x1d5ee],
  [0x1d608, 0x1d622],
  [0x1d63c, 0x1d656],
  [0x1d670, 0x1d68a],
];

const MATH_DIGIT: number[] = [0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6];

const ALPHA_SIZE = 26;
const DIGIT_SIZE = 10;
const UPPER_A = 0x41;
const LOWER_A = 0x61;
const DIGIT_0 = 0x30;

function mapMath(code: number): string | undefined {
  for (const [upper, lower] of MATH_ALPHA) {
    if (code >= upper && code < upper + ALPHA_SIZE) {
      return String.fromCodePoint(UPPER_A + code - upper);
    }
    if (code >= lower && code < lower + ALPHA_SIZE) {
      return String.fromCodePoint(LOWER_A + code - lower);
    }
  }
  for (const start of MATH_DIGIT) {
    if (code >= start && code < start + DIGIT_SIZE) {
      return String.fromCodePoint(DIGIT_0 + code - start);
    }
  }
  return undefined;
}

const EMOJI = String.raw`(?:[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{231A}-\u{23FF}])`;
/** Emoji runs between two letters are dropped: `ig😀nore` reads `ignore`. */
const EMOJI_BETWEEN = new RegExp(`(?<=[a-zA-Z])${EMOJI}+(?=[a-zA-Z])`, 'gu');
const EMOJI_CHAR = new RegExp(`^${EMOJI}$`, 'u');

const BACKSLASH_BEFORE_ALPHA = /\\(?=[a-zA-Z])/g;

/** What one code point reads as: stripped, folded to ASCII, or itself. */
function normalizeCodePoint(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (STRIP_SET.has(code)) return '';
  if (code >= COMBINING_LO && code <= COMBINING_HI) return '';
  if (code >= FULLWIDTH_LO && code <= FULLWIDTH_HI) {
    return String.fromCodePoint(code - FULLWIDTH_OFFSET);
  }
  const math = mapMath(code);
  if (math !== undefined) return math;
  const homo = HOMOGLYPH_MAP.get(code);
  if (homo !== undefined) return homo;
  if (SPACE_SET.has(code)) return ' ';
  return ch;
}

/** Whether a code point is one `EMOJI_BETWEEN` drops between letters. */
function isEmoji(ch: string): boolean {
  return EMOJI_CHAR.test(ch);
}

function normalizeForDetection(text: string): string {
  let out = '';
  for (const ch of text) {
    out += normalizeCodePoint(ch);
  }
  return out.replace(EMOJI_BETWEEN, '').replace(BACKSLASH_BEFORE_ALPHA, '');
}

export { isEmoji, normalizeCodePoint, normalizeForDetection };
