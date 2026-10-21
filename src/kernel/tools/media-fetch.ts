import { fetchGuarded } from '../../guardrails/network.ts';
import type { InteractionPart, ToolWarning } from '../turn-events.ts';
import { bytesToBase64 } from '../util/base64.ts';
import { toolNetworkPolicy } from './events.ts';
import type { ToolContext } from './types.ts';

/** The most pictures one call hands the model. */
export const MAX_TOOL_MEDIA_FILES = 4;

/** The largest picture fetched; a larger one is left out, not cut. */
const MAX_TOOL_MEDIA_BYTES = 5 * 1024 * 1024;

/** How long each picture may take, so a slow host cannot hold the call. */
const MEDIA_FETCH_TIMEOUT_MS = 15_000;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The body, read up to `maxBytes`; `undefined` when it runs past. */
async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function fetchOne(url: string, ctx: ToolContext): Promise<InteractionPart> {
  const timeout = AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const response = await fetchGuarded(
    url,
    { method: 'GET', headers: { Accept: 'image/*' }, signal },
    {
      policy: toolNetworkPolicy(ctx),
      followRedirects: true,
      resolveHost: ctx.resolveHost,
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (!mimeType || !IMAGE_TYPES.has(mimeType)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`not a png, jpeg, gif or webp image (${mimeType || 'no type'})`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const bytes = await readCappedBytes(response, MAX_TOOL_MEDIA_BYTES);
  if (!bytes) throw new Error(`larger than ${MAX_TOOL_MEDIA_BYTES} bytes`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return { type: 'image', mimeType, data: bytesToBase64(bytes) };
}

/**
 * The pictures a tool's `media(output)` names, fetched through the profile's network policy (every
 * hop, redirects included) and handed to the model as image parts. A picture that is blocked, slow,
 * too big or not an image is left out and reported in one `media_unfetched` warning: the call
 * itself stays whole.
 */
export async function fetchToolMedia(
  media: (output: never) => string[],
  output: unknown,
  ctx: ToolContext,
): Promise<{ parts: InteractionPart[]; warning?: ToolWarning }> {
  let urls: string[];
  try {
    urls = [...new Set(media(output as never))].slice(0, MAX_TOOL_MEDIA_FILES);
  } catch (err) {
    // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return { parts: [], warning: unfetched([`the media hook threw: ${String(err)}`]) };
  }
  const settled = await Promise.allSettled(urls.map((url) => fetchOne(url, ctx)));
  const parts: InteractionPart[] = [];
  const reasons: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') parts.push(result.value);
    else
      reasons.push(
        `${new URL(urls[index] ?? 'https://invalid.invalid').hostname}: ${String(result.reason instanceof Error ? result.reason.message : result.reason)}`,
      );
  });
  return { parts, ...(reasons.length ? { warning: unfetched(reasons) } : {}) };
}

function unfetched(reasons: string[]): ToolWarning {
  return {
    code: 'media_unfetched',
    severity: 'warning',
    message: `Some pictures the tool named were left out. ${reasons.join('; ')}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}
