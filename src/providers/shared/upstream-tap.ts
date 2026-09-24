import {
  describeError,
  isAbortError,
  isTimeoutError,
  TheoremError,
} from '../../guardrails/error.ts';
import type { KeySlot, ProviderCompleteRequest } from '../../kernel/types.ts';

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

/**
 * The request body as sent: parsed when it is JSON text, the text itself
 * otherwise. Every provider here sends string bodies; any other body kind
 * is named rather than read, since reading it would consume the stream.
 */
function tapeBody(body: RequestInit['body']): Record<string, unknown> {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'string') {
    return { bodyKind: body.constructor.name };
  }
  try {
    return { body: JSON.parse(body) };
  } catch {
    return { body };
  }
}

/**
 * Wrap one HTTP try so the tape sees it: request (with the key slot it was
 * sent under and its body), response status, error body, or throw.
 */
export function tapFetch(
  tap: ProviderCompleteRequest['tapUpstream'],
  send: typeof fetch = fetch,
  keySlot?: KeySlot,
): typeof fetch {
  if (!tap) {
    return send;
  }
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    tap({
      eventType: 'http_request',
      method,
      url: String(url),
      headers: tapeHeaders(init?.headers),
      ...(keySlot ? { keySlot } : {}),
      ...tapeBody(init?.body),
    });
    try {
      const res = await send(url, init);
      tap({
        eventType: 'http_response',
        status: res.status,
        headers: tapeHeaders(res.headers),
      });
      if (!res.ok) {
        tap({ eventType: 'http_error_body', body: await res.clone().text() });
      }
      return res;
    } catch (err) {
      tap(throwRow(err));
      throw err;
    }
  };
}

/**
 * The upstream could not be reached: a fetch rejection that is not an abort or
 * a timeout, since fetch rejects only when no response came back.
 */
export function networkError(err: unknown): unknown {
  if (err instanceof TheoremError || isAbortError(err) || isTimeoutError(err)) {
    return err;
  }
  return new TheoremError('network', describeError(err), { cause: err });
}

/** `send`, with a transport failure reported as a `network` error. */
export function networkFetch(send: typeof fetch = fetch): typeof fetch {
  return async (url, init) => {
    try {
      return await send(url, init);
    } catch (err) {
      throw networkError(err);
    }
  };
}
