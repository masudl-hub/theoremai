/**
 * One failure, two worlds, in the browser: the builder reads `errorKind` and
 * `errorInternal`; the user reads `error`, the profile's wording for it.
 *
 * @module
 */

import {
  describeError,
  type ErrorKind,
  errorKind,
  type LabelOverrides,
  labelText,
  publicError,
} from '@theoremjs/agents';
import type { AttachmentValidationIssue } from '@theoremjs/agents/interface';
import { isTheoremStreamError } from './transport.ts';

export type ClientFailure = {
  /** What the user reads: the host's wording, else the profile labels' for the failure. */
  error: string;
  errorKind: ErrorKind;
  /** Raw detail for the builder; never shown to the user. */
  errorInternal?: string;
};

/**
 * Word a caught value for the user with the profile's `labels` (the interface's
 * `labels`). A host-reported failure keeps the host's wording.
 */
export function clientFailure(err: unknown, labels?: LabelOverrides): ClientFailure {
  if (isTheoremStreamError(err)) {
    return {
      error: err.publicMessage ?? labelText(`error.${err.kind}`, {}, labels),
      errorKind: err.kind,
      ...(err.internalMessage ? { errorInternal: err.internalMessage } : {}),
    };
  }
  const error = publicError(err, labels);
  const internal = describeError(err);
  return {
    error,
    errorKind: errorKind(err),
    ...(internal && internal !== error ? { errorInternal: internal } : {}),
  };
}

/** A turn that did not run or did not finish. */
export type TurnFailure = ClientFailure & {
  /** The files the profile refused, one entry per reason (the kernel's check). */
  issues?: AttachmentValidationIssue[];
  /** The user stopped it; nothing to show. */
  aborted?: boolean;
};

/** A caught value as a turn failure; an aborted `signal` marks it the user's stop. */
export function turnFailure(
  err: unknown,
  labels?: LabelOverrides,
  signal?: AbortSignal,
): TurnFailure {
  const failure = clientFailure(err, labels);
  const aborted = failure.errorKind === 'cancelled' || signal?.aborted === true;
  return { ...failure, ...(aborted ? { aborted: true } : {}) };
}
