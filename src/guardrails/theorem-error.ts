/**
 * Contract-failure error class for THEOREM, and the kinds of failure it names.
 *
 * Lives in its own module so `lexicon.ts` can throw it without importing
 * `error.ts` (which resolves public copy through the lexicon).
 *
 * @module
 */

import type { LexiconKey, LexiconParams } from './lexicon.ts';

/**
 * What kind of failure happened, decided where it happens. Both worlds read it:
 * the builder in code and traces (`errorKind`, `error.type`), the user through
 * the kind's wording (`error.<kind>` in the lexicon).
 */
export const ERROR_KINDS = [
  /** The profile, tool, or schema is set up wrong. */
  'config',
  /** The host called THEOREM wrongly. */
  'request',
  /** The user sent input the profile does not accept. */
  'input',
  /** The user asked for something the profile does not allow. */
  'action',
  /** A missing or rejected credential, or an account that cannot be billed. */
  'auth',
  /** Too many requests, or a quota used up. */
  'rate_limit',
  /** The model or route cannot serve this request. */
  'unsupported',
  /** The provider is down or overloaded. */
  'unavailable',
  /** The provider answered with something that cannot be used. */
  'bad_response',
  /** The request never reached the provider. */
  'network',
  /** The model took longer than the host allowed. */
  'timeout',
  /** THEOREM or the provider held the reply back. */
  'safety',
  /** A guardrail or host policy stopped one of the agent's steps. */
  'blocked',
  /** The user declined one of the agent's steps. */
  'declined',
  /** One of the agent's steps ran and failed. */
  'failed',
  /** The user or host stopped the turn. */
  'cancelled',
  /** A THEOREM invariant broke. */
  'internal',
] as const;

/** What kind of failure happened. */
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Wording for the user more specific than its kind's: a lexicon key and its parameters. */
export interface ErrorCopy {
  key: LexiconKey;
  params?: LexiconParams;
}

/**
 * Options for a `TheoremError`: the standard `cause`, and the user wording when
 * it is more specific than the kind's — one line, or one per problem found.
 */
export interface TheoremErrorOptions extends ErrorOptions {
  copy?: ErrorCopy | readonly ErrorCopy[];
}

/** Error class used for expected THEOREM contract failures. */
export class TheoremError extends Error {
  readonly kind: ErrorKind;
  readonly copy?: ErrorCopy | readonly ErrorCopy[];

  constructor(kind: ErrorKind, message: string, options?: TheoremErrorOptions) {
    super(message, options);
    this.name = 'TheoremError';
    this.kind = kind;
    if (options?.copy) this.copy = options.copy;
  }
}
