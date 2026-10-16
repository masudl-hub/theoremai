import { readJsonString } from '../kernel/util/partial-json.ts';

/** The buffer may lack a closing quote; any decoded prefix is returned for live preview. */
export function readStreamingJsonStringField(jsonText: string, key: string): string | null {
  const keyLiteral = JSON.stringify(key);
  let keyAt = jsonText.indexOf(keyLiteral);
  let i = -1;
  while (keyAt >= 0) {
    i = keyAt + keyLiteral.length;
    while (/\s/.test(jsonText[i] ?? '')) {
      i += 1;
    }
    if (jsonText[i] === ':') {
      i += 1;
      while (/\s/.test(jsonText[i] ?? '')) {
        i += 1;
      }
      if (jsonText[i] === '"') {
        break;
      }
    }
    keyAt = jsonText.indexOf(keyLiteral, keyAt + keyLiteral.length);
  }
  if (keyAt < 0 || jsonText[i] !== '"') {
    return null;
  }
  return readJsonString(jsonText, i).text;
}
