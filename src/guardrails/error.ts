/**
 * Public-safe errors for THEOREM: two worlds from one fact.
 *
 * Every failure carries an `ErrorKind`, decided where it happens (a
 * `TheoremError`, a provider's HTTP status). The builder reads the kind and the
 * raw detail (`errorKind`, `errorInternal`, the trace's `error.type`); the user
 * reads the kind's wording (`error.<kind>`), which the profile's `lexicon`, then
 * `overrideLexicon`, may replace. Nothing is guessed from message text.
 *
 * @module
 */

import type { ToolCallEvent } from '../kernel/tools/types.ts';
import type { TurnEvent } from '../kernel/types.ts';
import { type LexiconOverrides, type LexiconParams, lexiconText } from './lexicon.ts';
import { type ErrorCopy, type ErrorKind, TheoremError } from './theorem-error.ts';

/** True when `err` is an abort (DOMException or Error named AbortError). */
function isAbortError(err: unknown): boolean {
  return errorName(err) === 'AbortError';
}

/** True when `err` is a timeout (`AbortSignal.timeout`, or an abort whose reason is a TimeoutError). */
function isTimeoutError(err: unknown): boolean {
  return errorName(err) === 'TimeoutError';
}

function errorName(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
}

/** Throw if `signal` is already aborted. */
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

/**
 * The kind of a thrown value. A `TheoremError` names its own; an abort is a
 * cancel, or a timeout when the signal timed out; anything else escaped every
 * boundary that names kinds, which is a THEOREM bug.
 */
function errorKind(err: unknown): ErrorKind {
  if (err instanceof TheoremError) return err.kind;
  if (isTimeoutError(err)) return 'timeout';
  if (isAbortError(err)) return 'cancelled';
  return 'internal';
}

/** The kind of a provider's non-OK HTTP status. */
function kindOfHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  return 'unsupported';
}

/** The user's wording for a kind: the profile's `lexicon` → `overrideLexicon` → default. */
function kindText(kind: ErrorKind, lexicon?: LexiconOverrides, params?: LexiconParams): string {
  return lexiconText(`error.${kind}`, params, lexicon);
}

/**
 * The user's wording for a failure: its own copy when it carries one (a line per
 * problem when it carries several), else its kind's.
 */
function wording(
  kind: ErrorKind,
  copy: ErrorCopy | readonly ErrorCopy[] | undefined,
  lexicon?: LexiconOverrides,
): string {
  if (!copy) return kindText(kind, lexicon);
  const lines = Array.isArray(copy) ? copy : [copy as ErrorCopy];
  return lines.map((line) => lexiconText(line.key, line.params, lexicon)).join('\n');
}

/**
 * User-safe text for a thrown value: its own wording when it carries one
 * (`TheoremError.copy`), else its kind's. Pass the profile's `lexicon` so a
 * profile's wording wins.
 */
function publicError(err: unknown, lexicon?: LexiconOverrides): string {
  return wording(errorKind(err), err instanceof TheoremError ? err.copy : undefined, lexicon);
}

/** Raw diagnostic text for hosts, traces, and logs (never shown to end users). */
function describeError(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * An error event as a producer knows it: the kind and the raw detail. The
 * user's wording is added where the event reaches the host
 * (`withPublicWording`), the one place that knows the profile.
 */
function toErrorEvent(err: unknown): {
  type: 'error';
  errorKind: ErrorKind;
  errorCopy?: ErrorCopy | readonly ErrorCopy[];
  errorInternal: string;
} {
  return {
    type: 'error',
    errorKind: errorKind(err),
    ...(err instanceof TheoremError && err.copy ? { errorCopy: err.copy } : {}),
    errorInternal: describeError(err),
  };
}

/**
 * Add the user's wording to an event on its way to the host: an error event's
 * `error`, and a failed tool step's `failure.error`. Wording already set (host
 * copy) is kept.
 */
function withPublicWording(event: TurnEvent, lexicon?: LexiconOverrides): TurnEvent {
  if (event.type === 'error' && event.error === undefined) {
    return { ...event, error: wording(event.errorKind ?? 'internal', event.errorCopy, lexicon) };
  }
  const failure = event.tool?.failure;
  if (event.tool && failure && failure.error === undefined) {
    const tool: ToolCallEvent = {
      ...event.tool,
      failure: { ...failure, error: kindText(failure.kind, lexicon, { tool: event.tool.name }) },
    };
    return { ...event, tool };
  }
  return event;
}

export type { ErrorCopy, ErrorKind, TheoremErrorOptions } from './theorem-error.ts';
export { ERROR_KINDS } from './theorem-error.ts';
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
