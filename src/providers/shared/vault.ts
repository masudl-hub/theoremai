import { TheoremError } from '../../guardrails/error.ts';
import type { KeySlot, KeyVault, ProviderCompleteRequest } from '../../kernel/types.ts';
import { tapFetch } from './upstream-tap.ts';

const HTTP_QUOTA = 429;

/** The key in `slot`. One vault serves every provider; a slot holds whatever secret the host put there. */
export function requireKey(vault: KeyVault | undefined, slot: KeySlot): string {
  const entry = vault?.[slot];
  const key = typeof entry === 'string' ? entry.trim() : undefined;
  if (!key) {
    throw new TheoremError('auth', `the vault has no key in slot '${slot}'`);
  }
  return key;
}

/** The profile's fallback slot and its key, when the vault holds a different key there. */
export function fallbackKey(
  slot: KeySlot | undefined,
  vault: KeyVault | undefined,
  primary: string,
): { slot: KeySlot; key: string } | undefined {
  const entry = slot ? vault?.[slot] : undefined;
  const key = typeof entry === 'string' ? entry.trim() : undefined;
  if (!slot || !key || key === primary) {
    return undefined;
  }
  return { slot, key };
}

export async function resolveFallbackKey(
  slot: KeySlot | undefined,
  vault: KeyVault | undefined,
  primary: string,
  signal?: AbortSignal | null,
): Promise<{ slot: KeySlot; key: string } | undefined> {
  if (!slot) return undefined;
  const entry = vault?.[slot];
  const value =
    typeof entry === 'function'
      ? await entry({ providerId: '', apiId: '', keySlot: slot, signal: signal ?? undefined })
      : entry;
  const key = typeof value === 'string' ? value.trim() : undefined;
  return key && key !== primary ? { slot, key } : undefined;
}

/**
 * A tapped fetch for a provider that takes a bearer token. `backoff` wraps each key's tapped
 * fetch, so every try is on the tape. A quota refusal, after any backoff, retries with the
 * fallback slot's key when the profile names one; each try's slot is on the tape.
 */
export function bearerFetch(
  req: Pick<ProviderCompleteRequest, 'tapUpstream' | 'keySlot' | 'fallbackKeySlot'>,
  send: typeof fetch,
  vault: KeyVault | undefined,
  primary: string,
  backoff: (send: typeof fetch) => typeof fetch = (tapped) => tapped,
): typeof fetch {
  const first = backoff(tapFetch(req.tapUpstream, send, req.keySlot));
  if (!req.fallbackKeySlot) return first;
  return async (url, init) => {
    const res = await first(url, init);
    if (res.status !== HTTP_QUOTA) {
      return res;
    }
    const fallback = await resolveFallbackKey(req.fallbackKeySlot, vault, primary, init?.signal);
    if (!fallback) return res;
    const second = backoff(tapFetch(req.tapUpstream, send, fallback.slot));
    await res.body?.cancel();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${fallback.key}`);
    return await second(url, { ...init, headers });
  };
}
