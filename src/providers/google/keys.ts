import type { KeySlot, KeyVault, ProviderCompleteRequest } from '../../kernel/types.ts';
import { retryTransient, type Wait } from '../shared/retry.ts';
import { networkFetch, tapFetch } from '../shared/upstream-tap.ts';
import { requireKey, resolveFallbackKey } from '../shared/vault.ts';

/** A host's Gemini settings; keys come from the one vault. */
interface GeminiOptions {
  wait?: Wait;
  fetch?: typeof fetch;
}

interface GeminiTransport extends GeminiOptions {
  vault: KeyVault;
}

const HTTP_QUOTA = 429;

export function withApiKey(init: RequestInit, apiKey: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('x-goog-api-key', apiKey);
  if (!headers.has('Content-Type') && (init.method || 'GET').toUpperCase() !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }
  return { ...init, headers };
}

interface FetchAttempt {
  href: string;
  init: RequestInit;
  apiKey: string;
  /** The slot `apiKey` came from; the tape records it per try. */
  slot: KeySlot;
  transport: GeminiTransport;
  tap: ProviderCompleteRequest['tapUpstream'];
}

async function fetchWithBackoff(args: FetchAttempt): Promise<Response> {
  const tapped = tapFetch(args.tap, args.transport.fetch ?? fetch, args.slot);
  const send = networkFetch(retryTransient(tapped, args.transport.wait));
  return await send(args.href, withApiKey(args.init, args.apiKey));
}

/**
 * Backs off on transient failures. A quota refusal retries once on the profile's fallback slot,
 * when it names one; each try's slot is on the tape, so the trace shows the switch.
 */
export async function fetchGemini(
  url: string,
  init: RequestInit,
  slot: KeySlot,
  transport: GeminiTransport,
  tap?: ProviderCompleteRequest['tapUpstream'],
  fallbackSlot?: KeySlot,
): Promise<Response> {
  const parsed = new URL(url);
  parsed.searchParams.delete('key');
  const href = parsed.toString();
  const primary = requireKey(transport.vault, slot);
  const first = { href, init, transport, tap };
  let last = await fetchWithBackoff({ ...first, apiKey: primary, slot });
  if (last.status === HTTP_QUOTA && fallbackSlot) {
    const fallback = await resolveFallbackKey(fallbackSlot, transport.vault, primary, init.signal);
    if (!fallback) return last;
    await last.body?.cancel();
    last = await fetchWithBackoff({ ...first, apiKey: fallback.key, slot: fallback.slot });
  }
  return last;
}

export type { GeminiOptions, GeminiTransport };
