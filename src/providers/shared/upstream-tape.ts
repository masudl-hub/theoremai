import { redactCanaryText } from '../../guardrails/canary.ts';
import { sha256, sha256Base64 } from '../../kernel/engine/hash.ts';
import { mapStrings } from '../../kernel/engine/tree.ts';

/*
 * Inline bytes on a taped row are stored as their sha256, never as bytes.
 * The shapes are the ones every taped transport sends (probes 23/09/2026):
 *
 * - `{ mime_type, data }`: Interactions request parts, stream deltas and
 *   buffered steps (image, audio, document); the OpenRouter speech body row.
 * - `{ mimeType, data }`: Theorem's own media parts (a tool's raw output) and
 *   Gemini Live `inlineData`.
 * - `{ b64_json, media_type }`: OpenRouter `/images` `data[]` entries.
 * - a `data:<mime>;base64,<bytes>` string: OpenRouter chat
 *   `message.images[].image_url.url`.
 *
 * The hash covers the raw bytes, the same hash a trace blob part carries. A
 * record whose bytes were hashed carries `dataKind: 'sha256'`; a hashed data
 * url becomes `data:<mime>;sha256,<hex>`. Inline data that is not base64 is
 * hashed as text and says so: `dataKind: 'text_sha256'`, `data:<mime>;text_sha256,<hex>`.
 */

const DATA_URL = /^data:([^;,]+);base64,/;

/** The key holding a record's inline bytes, when it has any. */
export function inlineBytesKey(rec: Record<string, unknown>): string | undefined {
  const mime = rec.mime_type ?? rec.mimeType;
  if (typeof mime === 'string' && typeof rec.data === 'string') {
    return 'data';
  }
  if (typeof rec.media_type === 'string' && typeof rec.b64_json === 'string') {
    return 'b64_json';
  }
  return undefined;
}

/** What an inline hash covers: the decoded bytes, or the text when it was not base64. */
const BYTES_SHA256 = 'sha256';
const TEXT_SHA256 = 'text_sha256';

/** The bytes' hash and its kind; text that is not base64 is hashed as text. */
async function inlineHash(base64: string): Promise<{ kind: string; hash: string }> {
  const digest = await sha256Base64(base64);
  return digest
    ? { kind: BYTES_SHA256, hash: digest.hash }
    : { kind: TEXT_SHA256, hash: await sha256(base64) };
}

async function scrubString(text: string): Promise<string> {
  const match = DATA_URL.exec(text);
  if (!match) {
    return text;
  }
  const { kind, hash } = await inlineHash(text.slice(match[0].length));
  return `data:${match[1]};${kind},${hash}`;
}

export async function scrubRecord(rec: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bytesKey = inlineBytesKey(rec);
  let dataKind: string | undefined;
  const pairs = await Promise.all(
    Object.entries(rec).map(async ([key, nested]): Promise<[string, unknown]> => {
      if (key === bytesKey && typeof nested === 'string') {
        const { kind, hash } = await inlineHash(nested);
        dataKind = kind;
        return [key, hash];
      }
      return [key, await scrubUpstream(nested)];
    }),
  );
  const out = Object.fromEntries(pairs);
  if (dataKind) {
    out.dataKind = dataKind;
  }
  return out;
}

export function scrubUpstream(value: unknown): Promise<unknown> {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => scrubUpstream(item)));
  }
  if (value && typeof value === 'object') {
    return scrubRecord(value as Record<string, unknown>);
  }
  return Promise.resolve(value);
}

/** `text` with every canary leak replaced by the omit marker. */
export function removeCanaries(text: string, canaries: readonly string[]): string {
  return canaries.reduce((out, canary) => redactCanaryText(out, canary), text);
}

export function redactCanaryInTree(value: unknown, canaries: readonly string[]): unknown {
  if (!canaries.some(Boolean)) {
    return value;
  }
  return mapStrings(value, (text) => removeCanaries(text, canaries));
}

export async function tapeUpstream(value: unknown, canaries: readonly string[]): Promise<unknown> {
  return redactCanaryInTree(await scrubUpstream(value), canaries);
}
