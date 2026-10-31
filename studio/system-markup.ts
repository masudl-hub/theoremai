import type { SystemPart, SystemPrompt } from '@theoremjs/agents/kernel';

/**
 * The studio's way to write a system prompt: the whole prompt as text, a blank
 * line starting a new line, each private section wrapped as `{private: …}`.
 */
type SystemMarkup = { ok: true; lines: SystemPrompt[] } | { ok: false; message: string };

const OPEN = /\{\s*private\s*:/g;
const BLANK_LINE = /\n(?:[ \t]*\n)+/;

/** A line as the profile holds it, without the white space at its ends. */
function promptLine(parts: readonly SystemPart[]): SystemPrompt | undefined {
  const [first, ...rest] = parts;
  if (first === undefined) return undefined;
  if (rest.length === 0 && typeof first === 'string') return first.trim() || undefined;
  const line = [...parts];
  const last = parts.at(-1);
  if (typeof first === 'string') line[0] = first.trimStart();
  if (typeof last === 'string') line[line.length - 1] = last.trimEnd();
  const kept = line.filter((part) => part !== '');
  const [only, ...others] = kept;
  return others.length === 0 && typeof only === 'string' ? only : kept;
}

/**
 * A section closes at the `}` that balances its `{`, so braces inside it pair
 * up as written, and a blank line inside it stays in it. Its text is trimmed;
 * the text around it is kept as written, apart from the ends of each line.
 */
function parseSystemMarkup(text: string): SystemMarkup {
  const lines: SystemPart[][] = [[]];
  const addText = (chunk: string) => {
    const [head = '', ...rest] = chunk.split(BLANK_LINE);
    lines.at(-1)?.push(head);
    lines.push(...rest.map((line) => [line]));
  };
  let at = 0;
  for (const open of text.matchAll(OPEN)) {
    if (open.index < at) continue;
    let depth = 1;
    let close = open.index + open[0].length;
    for (; close < text.length && depth > 0; close++) {
      if (text[close] === '{') depth++;
      else if (text[close] === '}') depth--;
    }
    addText(text.slice(at, open.index));
    if (depth > 0) {
      return {
        ok: false,
        message: `The {private: section on line ${String(lines.length)} has no closing }.`,
      };
    }
    const secret = text.slice(open.index + open[0].length, close - 1).trim();
    if (!secret) {
      return {
        ok: false,
        message: `The {private: section on line ${String(lines.length)} is empty.`,
      };
    }
    lines.at(-1)?.push({ private: secret });
    at = close;
  }
  addText(text.slice(at));
  return {
    ok: true,
    lines: lines.flatMap((parts) => {
      const line = promptLine(parts.filter((part) => part !== ''));
      return line === undefined ? [] : [line];
    }),
  };
}

export type { SystemMarkup };
export { parseSystemMarkup };
