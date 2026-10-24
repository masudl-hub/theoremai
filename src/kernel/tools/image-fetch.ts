import { fetchGuarded } from '../../guardrails/network.ts';
import type { InteractionPart, ToolWarning } from '../turn-events.ts';
import { bytesToBase64 } from '../util/base64.ts';
import { toolNetworkPolicy } from './events.ts';
import type { ToolContext, ToolImageLimits } from './types.ts';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The body, read up to `maxBytes` when set; `undefined` when it runs past. */
async function readCappedBytes(
  response: Response,
  maxBytes = Number.POSITIVE_INFINITY,
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

/** The call's signal, joined by the picture's own timeout when the tool sets one. */
function fetchSignal(ctx: ToolContext, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return ctx.signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

async function fetchOne(
  url: string,
  ctx: ToolContext,
  limits: ToolImageLimits,
): Promise<InteractionPart> {
  const signal = fetchSignal(ctx, limits.timeoutMs);
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
  const bytes = await readCappedBytes(response, limits.bytes);
  if (!bytes) throw new Error(`larger than ${limits.bytes} bytes`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return { type: 'image', mimeType, data: bytesToBase64(bytes) };
}

/** `url` when it is an absolute https address; otherwise the reason it is not. */
function httpsAddress(url: unknown): { url: string } | { reason: string } {
  if (typeof url !== 'string') return { reason: 'an address that is not text' }; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  try {
    if (new URL(url).protocol === 'https:') return { url };
  } catch {
    // why: an unparseable address is reported below as a reason, not thrown.
  }
  return { reason: `${url.slice(0, 80)}: not an absolute https address` }; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
}

/**
 * The pictures a tool's `images(output)` names, fetched through the profile's network policy (every
 * hop, redirects included, no tool credentials) and handed to the model as image parts. A picture
 * that is not an https address, blocked, slow, too big or not an image is left out and reported in
 * one `images_unfetched` warning: the call itself stays whole. `urls` are the ones fetched.
 */
export async function fetchToolImages(
  images: (output: never) => string[],
  output: unknown,
  ctx: ToolContext,
  limits: ToolImageLimits = {},
): Promise<{ parts: InteractionPart[]; urls: string[]; warning?: ToolWarning }> {
  const reasons: string[] = [];
  const named: string[] = [];
  try {
    for (const raw of new Set(images(output as never))) {
      const address = httpsAddress(raw);
      if ('url' in address) named.push(address.url);
      else reasons.push(address.reason);
    }
  } catch (err) {
    // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return {
      parts: [],
      urls: [],
      warning: unfetched([`the images hook threw: ${String(err)}`]), // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    };
  }
  const wanted = named.slice(0, limits.count);
  const settled = await Promise.allSettled(wanted.map((url) => fetchOne(url, ctx, limits)));
  const totalBytes = limits.totalBytes ?? Number.POSITIVE_INFINITY;
  const parts: InteractionPart[] = [];
  const urls: string[] = [];
  let total = 0;
  settled.forEach((result, index) => {
    const url = wanted[index] as string;
    if (result.status === 'rejected') {
      const why = result.reason instanceof Error ? result.reason.message : String(result.reason);
      reasons.push(`${new URL(url).hostname}: ${why}`);
      return;
    }
    const size = 'data' in result.value ? result.value.data.length : 0;
    if (total + size > totalBytes) {
      reasons.push(`${new URL(url).hostname}: past the ${totalBytes} byte total`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return;
    }
    total += size;
    parts.push(result.value);
    urls.push(url);
  });
  return {
    parts,
    urls,
    ...(reasons.length ? { warning: unfetched(reasons) } : {}),
  };
}

function unfetched(reasons: string[]): ToolWarning {
  return {
    code: 'images_unfetched',
    severity: 'warning',
    message: `Some pictures the tool named were left out. ${reasons.join('; ')}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}
