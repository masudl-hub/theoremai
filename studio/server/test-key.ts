/**
 * Asks a key's provider whether it accepts the key, so the builder can tell a bad key
 * from a bad setting. The key is used for this one request: never logged, kept, or echoed back.
 */
import { z } from '@theoremjs/agents';
import { readBody } from '@theoremjs/web/server';

const TIMEOUT_MS = 8000;
const MAX_KEY_LENGTH = 512;
const SAID_CAP = 300;

type KeyCheck = {
  ok: boolean;
  provider?: string;
  status?: number;
  /** What the provider said, with the key taken out. */
  said?: string;
  error?: string;
};

const PROVIDERS = [
  {
    provider: 'google',
    matches: (key: string) => key.startsWith('AIza'),
    request: (key: string) =>
      new Request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
        headers: { 'x-goog-api-key': key },
      }),
  },
  {
    provider: 'openrouter',
    matches: (key: string) => key.startsWith('sk-or-'),
    request: (key: string) =>
      new Request('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
] as const;

/** The provider's own error message, if it sent one, without the key. */
async function providerSaid(response: Response, key: string): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { message?: unknown } | unknown[] } | null)?.error;
    const first = Array.isArray(error) ? error[0] : error;
    const message = (first as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string') return undefined;
    return message.replaceAll(key, '[the key]').slice(0, SAID_CAP);
  } catch {
    return undefined;
  }
}

/** `POST <base>/test-key` `{ key }`. */
export async function testKey(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let key = '';
  try {
    const body = await readBody(request, z.unknown());
    const value = (body as { key?: unknown } | null)?.key;
    key = typeof value === 'string' ? value.trim() : '';
  } catch {
    return Response.json({ ok: false, error: 'Send { key }.' } satisfies KeyCheck, { status: 400 });
  }
  if (!key || key.length > MAX_KEY_LENGTH) {
    return Response.json({ ok: false, error: 'No key to test.' } satisfies KeyCheck, {
      status: 400,
    });
  }
  const match = PROVIDERS.find((candidate) => candidate.matches(key));
  if (!match) {
    return Response.json({
      ok: false,
      error: 'Only Google (AIza…) and OpenRouter (sk-or-…) keys can be tested here.',
    } satisfies KeyCheck);
  }
  try {
    const response = await fetch(match.request(key), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const result: KeyCheck = {
      ok: response.ok,
      provider: match.provider,
      status: response.status,
      ...(response.ok ? {} : { said: await providerSaid(response, key) }),
    };
    return Response.json(result);
  } catch {
    return Response.json({
      ok: false,
      provider: match.provider,
      error: `Couldn't reach ${match.provider}.`,
    } satisfies KeyCheck);
  }
}
