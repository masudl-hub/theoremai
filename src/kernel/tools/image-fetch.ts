import { fetchGuarded } from '../../guardrails/network.ts';
import type {
  InteractionMediaPart,
  ToolOutputPart,
  ToolOutputRefPart,
  ToolWarning,
} from '../turn-events.ts';
import { bytesToBase64 } from '../util/base64.ts';
import { isRecord } from '../util/record.ts';
import { toolNetworkPolicy } from './events.ts';
import { toolOutputRefPartSchema } from './output-parts.ts';
import type { ToolContext, ToolImageLimits, ToolMediaEntry } from './types.ts';

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
): Promise<InteractionMediaPart> {
  const signal = fetchSignal(ctx, limits.timeoutMs);
  const response = await fetchGuarded(
    url,
    { method: 'GET', headers: { Accept: 'image/*' }, signal },
    {
      policy: toolNetworkPolicy(ctx),
      followRedirects: true,
      resolveHost: ctx.resolveHost,
      fetchFn: ctx.fetch,
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
 * The media a tool's `media(output)` names. Each `{ url }` picture is fetched through the profile's
 * network policy (every hop, redirects included, no tool credentials) and handed to the model as an
 * image part, `sent` when the entry says so. A picture that is not an https address, blocked, slow,
 * too big or not an image is left out and reported in one `images_unfetched` warning: the call
 * itself stays whole. Each reference `{ type, mimeType, uri }` is kept as it is, for the person
 * only. `urls` are the pictures fetched.
 */
export async function fetchToolMedia(
  hook: (output: never) => ToolMediaEntry[],
  output: unknown,
  ctx: ToolContext,
  limits: ToolImageLimits = {},
): Promise<{ media: ToolOutputPart[]; urls: string[]; warning?: ToolWarning }> {
  const reasons: string[] = [];
  const named = new Map<string, boolean>();
  const refs: ToolOutputRefPart[] = [];
  try {
    for (const entry of hook(output as never)) {
      const ref = mediaRef(entry);
      if (ref) {
        refs.push(ref);
        continue;
      }
      const address = httpsAddress(isRecord(entry) ? entry.url : entry);
      if ('reason' in address) reasons.push(address.reason);
      else named.set(address.url, named.get(address.url) === true || sentEntry(entry));
    }
  } catch (err) {
    // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return {
      media: [],
      urls: [],
      warning: unfetched([`the media hook threw: ${String(err)}`]), // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    };
  }
  const wanted = [...named.keys()].slice(0, limits.count);
  const settled = await Promise.allSettled(wanted.map((url) => fetchOne(url, ctx, limits)));
  const totalBytes = limits.totalBytes ?? Number.POSITIVE_INFINITY;
  const media: ToolOutputPart[] = [];
  const urls: string[] = [];
  let total = 0;
  settled.forEach((result, index) => {
    const url = wanted[index] as string;
    if (result.status === 'rejected') {
      const why = result.reason instanceof Error ? result.reason.message : String(result.reason);
      reasons.push(`${new URL(url).hostname}: ${why}`);
      return;
    }
    const size = result.value.data.length;
    if (total + size > totalBytes) {
      reasons.push(`${new URL(url).hostname}: past the ${totalBytes} byte total`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return;
    }
    total += size;
    media.push(named.get(url) ? { ...result.value, sent: true } : result.value);
    urls.push(url);
  });
  return {
    media: [...media, ...refs],
    urls,
    ...(reasons.length ? { warning: unfetched(reasons) } : {}),
  };
}

function sentEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.sent === true;
}

/** The entry as a reference, when it is one. */
function mediaRef(entry: unknown): ToolOutputRefPart | undefined {
  const ref = toolOutputRefPartSchema.safeParse(entry);
  return ref.success ? ref.data : undefined;
}

function unfetched(reasons: string[]): ToolWarning {
  return {
    code: 'images_unfetched',
    severity: 'warning',
    message: `Some pictures the tool named were left out. ${reasons.join('; ')}`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  };
}
