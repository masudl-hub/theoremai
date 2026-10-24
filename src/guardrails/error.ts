import type { TurnEventOf } from '../kernel/turn-events.ts';
import type { TurnEvent } from '../kernel/types.ts';
import { type LabelOverrides, type LabelParams, labelText } from './labels.ts';
import { type ErrorCopies, type ErrorKind, TheoremError } from './theorem-error.ts';

/** True when the value is an error named `AbortError`. */
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

/** Throws when the signal has aborted: its framework, abort or timeout reason, else an `AbortError`. */
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const { reason } = signal;
  if (reason instanceof TheoremError || isAbortError(reason) || isTimeoutError(reason)) {
    throw reason;
  }
  throw new DOMException('The operation was aborted.', 'AbortError'); // labels-exempt: DOM AbortError fingerprint
}

/** Anything that is not a `TheoremError` or an abort escaped every boundary that names kinds: a THEOREM bug. */
function errorKind(err: unknown): ErrorKind {
  if (err instanceof TheoremError) return err.kind;
  if (isTimeoutError(err)) return 'timeout';
  if (isAbortError(err)) return 'cancelled';
  return 'internal';
}

/** The error kind for an HTTP status: 401, 402 and 403 are `auth`; 408, 504 and 524 `timeout`; 429 `rate_limit`; 503 and 529 (overloaded) `busy`; 500 and above `unavailable`; the rest `unsupported`. */
function kindOfHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 529) return 'busy';
  if (status >= 500) return 'unavailable';
  return 'unsupported';
}

function kindText(kind: ErrorKind, labels?: LabelOverrides, params?: LabelParams): string {
  return labelText(`error.${kind}`, params, labels);
}

function wording(kind: ErrorKind, copy: ErrorCopies | undefined, labels?: LabelOverrides): string {
  return copy ? errorCopyText(copy, labels) : kindText(kind, labels);
}

/** The named reasons an error carries, one line each, in the profile's wording. */
function errorCopyText(copy: ErrorCopies, labels?: LabelOverrides): string {
  const lines = 'key' in copy ? [copy] : copy;
  return lines.map((line) => labelText(line.key, line.params, labels)).join('\n');
}

/** Pass the profile's `labels`, or the profile's wording is skipped. */
function publicError(err: unknown, labels?: LabelOverrides): string {
  return wording(errorKind(err), err instanceof TheoremError ? err.copy : undefined, labels);
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/** Raw diagnostic for hosts, traces, and logs; never shown to end users. Each cause that says something new follows on its own line. */
function describeError(err: unknown): string {
  const lines = [messageOf(err)];
  const seen = new Set<unknown>([err]);
  let said = messageOf(err);
  let cause = err instanceof Error ? err.cause : undefined;
  while (cause !== undefined && cause !== null && !seen.has(cause)) {
    seen.add(cause);
    const message = messageOf(cause);
    if (message !== said) {
      const name = cause instanceof Error && cause.name !== 'Error' ? `${cause.name}: ` : '';
      lines.push(`caused by: ${name}${message}`);
      said = message;
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join('\n');
}

type ProducedError = TurnEventOf<'error'> & { errorInternal: string };

/** No user wording yet: `withPublicLabels` adds it where the event reaches the host, the one place that knows the profile. */
function toErrorEvent(err: unknown): ProducedError {
  return {
    type: 'error',
    errorKind: errorKind(err),
    ...(err instanceof TheoremError && err.copy ? { errorCopy: err.copy } : {}),
    errorInternal: describeError(err),
  };
}

/** Wording already set (host copy) is kept. */
function withPublicLabels(event: TurnEvent, labels?: LabelOverrides): TurnEvent {
  if (event.type === 'error' && event.error === undefined) {
    return { ...event, error: wording(event.errorKind, event.errorCopy, labels) };
  }
  if (
    event.type === 'tool' &&
    event.tool.phase === 'error' &&
    event.tool.failure.error === undefined
  ) {
    const { tool } = event;
    const error = kindText(tool.failure.kind, labels, { tool: tool.name });
    return { ...event, tool: { ...tool, failure: { ...tool.failure, error } } };
  }
  return event;
}

export type { ErrorCopies, ErrorCopy, ErrorKind, TheoremErrorOptions } from './theorem-error.ts';
export { ERROR_KINDS } from './theorem-error.ts';
export type { ProducedError };
export {
  describeError,
  errorCopyText,
  errorKind,
  isAbortError,
  isTimeoutError,
  kindOfHttpStatus,
  publicError,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  withPublicLabels,
};
