/**
 * Reads JSON text the model is still writing: what is whole so far, and the string it is in the
 * middle of. For previews only; the text once whole is parsed as JSON.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** A JSON string read from its opening quote: its text so far, and where it closed, if it has. */
interface StringRead {
  text: string;
  /** The index just past the closing quote; none while the string is still open. */
  end?: number;
}

/**
 * The string whose opening quote is at `at`, unescaped as far as `text` goes. An escape cut off at
 * the end is left out rather than shown wrong; an escape JSON does not have reads as its letter.
 */
function readJsonString(text: string, at: number): StringRead {
  let out = '';
  let i = at + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"') return { text: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    if (i + 1 >= text.length) break;
    const code = text.charAt(i + 1);
    if (code === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
    }
    out += ESCAPES[code] ?? code;
    i += 2;
  }
  return { text: out };
}

function skipSpace(text: string, i: number): number {
  let at = i;
  while (/\s/.test(text.charAt(at))) at++;
  return at;
}

/** The JSON value at `at` in `text` and the index past it, or none while `text` ends before it does. */
function wholeJsonValueAt(text: string, at: number): { value: unknown; end: number } | undefined {
  if (text.charAt(at) === '"') {
    const read = readJsonString(text, at);
    return read.end === undefined ? undefined : parsedSlice(text, at, read.end);
  }
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '"') {
      const end = readJsonString(text, i).end;
      if (end === undefined) return undefined;
      i = end - 1;
    } else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) return parsedSlice(text, at, i);
      depth--;
      if (depth === 0) return parsedSlice(text, at, i + 1);
    } else if (ch === ',' && depth === 0) return parsedSlice(text, at, i);
  }
  return undefined;
}

function parsedSlice(text: string, from: number, to: number) {
  try {
    return { value: JSON.parse(text.slice(from, to)) as unknown, end: to };
  } catch {
    return undefined;
  }
}

/**
 * The top-level fields of a JSON object the model is still writing: each field whose value is
 * whole, and the string being written, as far as it goes. A number, object or array still being
 * written is left out: it is not its value yet.
 */
function partialJsonObject(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let i = skipSpace(text, 0);
  if (text.charAt(i) !== '{') return fields;
  i++;
  for (;;) {
    i = skipSpace(text, i);
    if (text.charAt(i) === ',') i = skipSpace(text, i + 1);
    if (text.charAt(i) !== '"') return fields;
    const key = readJsonString(text, i);
    if (key.end === undefined) return fields;
    i = skipSpace(text, key.end);
    if (text.charAt(i) !== ':') return fields;
    i = skipSpace(text, i + 1);
    if (i >= text.length) return fields;
    const value = wholeJsonValueAt(text, i);
    if (!value) {
      if (text.charAt(i) === '"') fields[key.text] = readJsonString(text, i).text;
      return fields;
    }
    fields[key.text] = value.value;
    i = value.end;
  }
}

export type { StringRead };
export { partialJsonObject, readJsonString };
