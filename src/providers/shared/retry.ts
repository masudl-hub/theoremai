import { isAbortError, isTimeoutError } from '../../guardrails/error.ts';

/** How a retry waits; a host or test may pass its own. The signal ends the wait early. */
export type Wait = (ms: number, signal?: AbortSignal | null) => Promise<void>;

const ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];
/** A longer `Retry-After` is not worth holding a turn for; the refusal goes back instead. */
const RETRY_AFTER_CAP_MS = 60_000;
const MS_PER_SECOND = 1000;

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const TRANSIENT_THROWN_RE =
  /name resolution|dns|econnreset|econnrefused|etimedout|connection (?:refused|reset)|error sending request|network|fetch failed|temporarily unavailable|socket|503|502|504/i;

export const waitDefault: Wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function isTransientHttp(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

export function isTransientThrown(err: unknown): boolean {
  if (isAbortError(err) || isTimeoutError(err)) {
    return false;
  }
  return TRANSIENT_THROWN_RE.test(String(err));
}

export function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number;
}

/** `retry-after-ms`, else `Retry-After` in seconds or as a date; undefined when absent or past the cap. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  const after = headers.get('retry-after');
  let delay: number | undefined;
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms))) {
    delay = Number(ms);
  } else if (after !== null && after.trim() !== '') {
    const seconds = Number(after);
    delay = Number.isFinite(seconds) ? seconds * MS_PER_SECOND : Date.parse(after) - now;
  }
  if (delay === undefined || Number.isNaN(delay) || delay < 0 || delay > RETRY_AFTER_CAP_MS) {
    return undefined;
  }
  return delay;
}

/**
 * Sends up to three tries: a transient status (408, 429, 5xx gateway) or a network failure waits
 * the response's `Retry-After` when it gives one under a minute, else 1s then 2s. The last answer
 * or error goes back as it came; an abort ends the wait.
 */
export function retryTransient(send: typeof fetch, wait: Wait = waitDefault): typeof fetch {
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt === ATTEMPTS - 1;
      let delay: number;
      try {
        const res = await send(url, init);
        if (last || !isTransientHttp(res.status)) {
          return res;
        }
        delay = retryAfterMs(res.headers) ?? backoffMs(attempt);
        await res.body?.cancel();
      } catch (err) {
        if (last || !isTransientThrown(err)) {
          throw err;
        }
        delay = backoffMs(attempt);
      }
      await wait(delay, init?.signal);
    }
  };
}
