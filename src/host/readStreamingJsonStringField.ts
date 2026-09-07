const JSON_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

function decodeEscapedChar(
  ch: string,
  jsonText: string,
  index: number,
): { text: string; next: number } {
  if (ch === 'u' && index + 4 < jsonText.length) {
    const hex = jsonText.slice(index + 1, index + 5);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return { text: String.fromCharCode(Number.parseInt(hex, 16)), next: index + 4 };
    }
  }
  const mapped = JSON_ESCAPES[ch];
  return { text: mapped ?? ch, next: index };
}

/**
 * Read one string field from incomplete JSON while structured output streams as text deltas.
 *
 * The buffer may lack a closing quote; any decoded prefix is returned for live preview.
 */
export function readStreamingJsonStringField(jsonText: string, key: string): string | null {
  const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = keyPattern.exec(jsonText);
  if (!match || match.index === undefined) {
    return null;
  }

  let i = match.index + match[0].length;
  let result = '';
  let escaped = false;

  while (i < jsonText.length) {
    const ch = jsonText[i];
    if (escaped) {
      const decoded = decodeEscapedChar(ch, jsonText, i);
      result += decoded.text;
      i = decoded.next;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      return result;
    } else {
      result += ch;
    }
    i += 1;
  }

  return result;
}
