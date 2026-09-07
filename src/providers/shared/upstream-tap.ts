import type { ProviderCompleteRequest } from '../../kernel/types.ts';

const SECRET_HEADER = /key|auth|cookie|secret|token/i;

export function tapeHeaderValue(key: string, value: string): string {
  if (SECRET_HEADER.test(key)) {
    return '[redacted]';
  }
  return value;
}

export function tapeHeaders(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new Headers(headers).entries()) {
    out[key] = tapeHeaderValue(key, value);
  }
  return out;
}

export function throwRow(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { eventType: 'http_throw', name: err.name, message: err.message };
  }
  return { eventType: 'http_throw', name: 'Error', message: String(err) };
}

export function tapFetch(
  tap: ProviderCompleteRequest['tapUpstream'],
  send: typeof fetch = fetch,
): typeof fetch {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    tap?.({
      eventType: 'http_request',
      method,
      url: String(url),
      headers: tapeHeaders(init?.headers),
    });
    try {
      const res = await send(url, init);
      tap?.({
        eventType: 'http_response',
        status: res.status,
        headers: tapeHeaders(res.headers),
      });
      if (!res.ok) {
        tap?.({ eventType: 'http_error_body', body: await res.clone().text() });
      }
      return res;
    } catch (err) {
      tap?.(throwRow(err));
      throw err;
    }
  };
}
