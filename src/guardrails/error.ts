import type { TurnEventOf } from '../kernel/turn-events.ts';
import type { TurnEvent } from '../kernel/types.ts';
import { type LexiconOverrides, type LexiconParams, lexiconText } from './lexicon.ts';
import { type ErrorCopies, type ErrorKind, TheoremError } from './theorem-error.ts';

function isAbortError(err: unknown): boolean {
  return errorName(err) === 'AbortError';
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`, not an `AbortError`. */
function isTimeoutError(err: unknown): boolean {
  return errorName(err) === 'TimeoutError';
}

function errorName(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const { reason } = signal;
  if (isAbortError(reason) || isTimeoutError(reason)) {
    throw reason;
  }
  throw new DOMException('The operation was aborted.', 'AbortError'); // lexicon-exempt: DOM AbortError fingerprint
}

/** Anything that is not a `TheoremError` or an abort escaped every boundary that names kinds: a THEOREM bug. */
function errorKind(err: unknown): ErrorKind {
  if (err instanceof TheoremError) return err.kind;
  if (isTimeoutError(err)) return 'timeout';
  if (isAbortError(err)) return 'cancelled';
  return 'internal';
}

function kindOfHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  return 'unsupported';
}

function kindText(kind: ErrorKind, lexicon?: LexiconOverrides, params?: LexiconParams): string {
  return lexiconText(`error.${kind}`, params, lexicon);
}

function wording(
  kind: ErrorKind,
  copy: ErrorCopies | undefined,
  lexicon?: LexiconOverrides,
): string {
  if (!copy) return kindText(kind, lexicon);
  const lines = 'key' in copy ? [copy] : copy;
  return lines.map((line) => lexiconText(line.key, line.params, lexicon)).join('\n');
}

/** Pass the profile's `lexicon`, or the profile's wording is skipped. */
function publicError(err: unknown, lexicon?: LexiconOverrides): string {
  return wording(errorKind(err), err instanceof TheoremError ? err.copy : undefined, lexicon);
}

/** Raw diagnostic for hosts, traces and logs; never shown to end users. */
function describeError(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

type ProducedError = TurnEventOf<'error'> & { errorInternal: string };

/** No user wording yet: `withPublicWording` adds it where the event reaches the host, the one place that knows the profile. */
function toErrorEvent(err: unknown): ProducedError {
  return {
    type: 'error',
    errorKind: errorKind(err),
    ...(err instanceof TheoremError && err.copy ? { errorCopy: err.copy } : {}),
    errorInternal: describeError(err),
  };
}

/** Wording already set (host copy) is kept. */
function withPublicWording(event: TurnEvent, lexicon?: LexiconOverrides): TurnEvent {
  if (event.type === 'error' && event.error === undefined) {
    return { ...event, error: wording(event.errorKind, event.errorCopy, lexicon) };
  }
  if (
    event.type === 'tool' &&
    event.tool.phase === 'error' &&
    event.tool.failure.error === undefined
  ) {
    const { tool } = event;
    const error = kindText(tool.failure.kind, lexicon, { tool: tool.name });
    return { ...event, tool: { ...tool, failure: { ...tool.failure, error } } };
  }
  return event;
}

export type { ErrorCopies, ErrorCopy, ErrorKind, TheoremErrorOptions } from './theorem-error.ts';
export { ERROR_KINDS } from './theorem-error.ts';
export type { ProducedError };
export {
  describeError,
  errorKind,
  isAbortError,
  isTimeoutError,
  kindOfHttpStatus,
  publicError,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  withPublicWording,
};
