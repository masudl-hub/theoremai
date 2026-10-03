import type { SystemPart, SystemPrompt } from '../src/kernel/types.ts';

/**
 * The playground's way to write a system prompt with private sections: the
 * whole prompt as text, each private section wrapped as `{private: …}`.
 */
type SystemMarkup = { ok: true; prompt: SystemPrompt | undefined } | { ok: false; message: string };

const OPEN = /\{\s*private\s*:/g;

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * A section closes at the `}` that balances its `{`, so braces inside it pair
 * up as written. Its text is trimmed; the text around it is kept as written,
 * apart from the ends of the whole prompt.
 */
function parseSystemMarkup(text: string): SystemMarkup {
  const parts: SystemPart[] = [];
  let at = 0;
  for (const open of text.matchAll(OPEN)) {
    if (open.index < at) continue;
    let depth = 1;
    let close = open.index + open[0].length;
    for (; close < text.length && depth > 0; close++) {
      if (text[close] === '{') depth++;
      else if (text[close] === '}') depth--;
    }
    if (depth > 0) {
      return {
        ok: false,
        message: `The {private: section on line ${String(lineAt(text, open.index))} has no closing }.`,
      };
    }
    const secret = text.slice(open.index + open[0].length, close - 1).trim();
    if (!secret) {
      return {
        ok: false,
        message: `The {private: section on line ${String(lineAt(text, open.index))} is empty.`,
      };
    }
    parts.push(text.slice(at, open.index), { private: secret });
    at = close;
  }
  parts.push(text.slice(at));
  if (parts.length === 1) return { ok: true, prompt: text.trim() || undefined };
  const first = parts[0];
  const last = parts.at(-1);
  if (typeof first === 'string') parts[0] = first.trimStart();
  if (typeof last === 'string') parts[parts.length - 1] = last.trimEnd();
  return { ok: true, prompt: parts.filter((part) => part !== '') };
}

export type { SystemMarkup };
export { parseSystemMarkup };
