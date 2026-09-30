import { TheoremError } from '../../guardrails/error.ts';
import type { KeySlot, KeyVault, ProviderCompleteRequest } from '../../kernel/types.ts';
import { tapFetch } from './upstream-tap.ts';

const HTTP_QUOTA = 429;

/** The key in `slot`. One vault serves every provider; a slot holds whatever secret the host put there. */
export function requireKey(vault: KeyVault | undefined, slot: KeySlot): string {
  const key = vault?.[slot]?.trim();
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
  const key = slot ? vault?.[slot]?.trim() : undefined;
  if (!slot || !key || key === primary) {
    return undefined;
  }
  return { slot, key };
}

/**
 * A tapped fetch for a provider that takes a bearer token. A quota refusal retries once with the
 * fallback slot's key, when the profile names one; each try's slot is on the tape.
 */
export function bearerFetch(
  req: Pick<ProviderCompleteRequest, 'tapUpstream' | 'keySlot' | 'fallbackKeySlot'>,
  send: typeof fetch,
  vault: KeyVault | undefined,
  primary: string,
): typeof fetch {
  const first = tapFetch(req.tapUpstream, send, req.keySlot);
  const fallback = req.keySlot ? fallbackKey(req.fallbackKeySlot, vault, primary) : undefined;
  if (!fallback) {
    return first;
  }
  const second = tapFetch(req.tapUpstream, send, fallback.slot);
  return async (url, init) => {
    const res = await first(url, init);
    if (res.status !== HTTP_QUOTA) {
      return res;
    }
    await res.body?.cancel();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${fallback.key}`);
    return await second(url, { ...init, headers });
  };
}
