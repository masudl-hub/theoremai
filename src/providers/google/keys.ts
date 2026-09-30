import { isAbortError, TheoremError } from '../../guardrails/error.ts';
import type { KeySlot, KeyVault, ProviderCompleteRequest } from '../../kernel/types.ts';
import { networkError, tapFetch } from '../shared/upstream-tap.ts';

interface GeminiTransport {
  vault: KeyVault;
  wait?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

const ATTEMPTS = 3;
const LAST_ATTEMPT = ATTEMPTS - 1;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_SECOND_MS = 2000;
const BACKOFF_THIRD_MS = 4000;
const BACKOFF_MS = [BACKOFF_FIRST_MS, BACKOFF_SECOND_MS, BACKOFF_THIRD_MS];

const HTTP_TIMEOUT = 408;
const HTTP_QUOTA = 429;
const HTTP_SERVER = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;

const TRANSIENT_THROWN_RE =
  /name resolution|dns|econnreset|econnrefused|etimedout|network|fetch failed|temporarily unavailable|socket|503|502|504/i;

export function waitDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isTransientHttp(status: number): boolean {
  return (
    status === HTTP_TIMEOUT ||
    status === HTTP_QUOTA ||
    status === HTTP_SERVER ||
    status === HTTP_BAD_GATEWAY ||
    status === HTTP_UNAVAILABLE ||
    status === HTTP_GATEWAY_TIMEOUT
  );
}

export function isTransientThrown(err: unknown): boolean {
  if (isAbortError(err)) {
    return false;
  }
  return TRANSIENT_THROWN_RE.test(String(err));
}

export function requireKey(vault: KeyVault, slot: KeySlot): string {
  const key = vault[slot];
  if (!key) {
    throw new TheoremError('auth', `gemini.vault has no key in slot '${slot}'`);
  }
  return key;
}

export function backoffMs(attempt: number): number {
  return BACKOFF_MS[attempt] ?? BACKOFF_SECOND_MS;
}

/** The profile's fallback slot and its key, when the vault holds a different key there. */
export function fallbackKey(
  slot: KeySlot | undefined,
  vault: KeyVault,
  primary: string,
): { slot: KeySlot; key: string } | undefined {
  const key = slot ? vault[slot] : undefined;
  if (!slot || !key || key === primary) {
    return undefined;
  }
  return { slot, key };
}

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
  attempt: number;
}

async function fetchWithBackoff(args: FetchAttempt): Promise<Response> {
  const wait = args.transport.wait ?? waitDefault;
  const send = tapFetch(args.tap, args.transport.fetch ?? fetch, args.slot);
  try {
    const last = await send(args.href, withApiKey(args.init, args.apiKey));
    if (!isTransientHttp(last.status) || args.attempt === LAST_ATTEMPT) {
      return last;
    }
    if (args.init.signal?.aborted) {
      throw args.init.signal.reason instanceof Error
        ? args.init.signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
    }
    await wait(backoffMs(args.attempt));
    return fetchWithBackoff({ ...args, attempt: args.attempt + 1 });
  } catch (err) {
    if (isAbortError(err) || !isTransientThrown(err) || args.attempt === LAST_ATTEMPT) {
      throw networkError(err);
    }
    await wait(backoffMs(args.attempt));
    return fetchWithBackoff({ ...args, attempt: args.attempt + 1 });
  }
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
  const first = { href, init, transport, tap, attempt: 0 };
  let last = await fetchWithBackoff({ ...first, apiKey: primary, slot });
  const fallback = fallbackKey(fallbackSlot, transport.vault, primary);
  if (last.status === HTTP_QUOTA && fallback) {
    last = await fetchWithBackoff({ ...first, apiKey: fallback.key, slot: fallback.slot });
  }
  return last;
}

export type { GeminiTransport };
