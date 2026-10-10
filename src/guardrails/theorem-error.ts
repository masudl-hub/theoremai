// invariant: Its own module so `lexicon.ts` can throw it without importing `error.ts`, which reads the lexicon.

import type { ErrorCopies, ErrorCopy } from './event-schemas.ts';

export type { ErrorCopies, ErrorCopy };

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

/** Why an operation failed; the user's wording and the HTTP status follow from it. */
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Options for a `TheoremError`: the cause and, optionally, wording for the user. */
export interface TheoremErrorOptions extends ErrorOptions {
  /** User wording more specific than the kind's: one line, or one per problem found. */
  copy?: ErrorCopies;
}

/** An error that carries a `kind`, from which hosts choose a status and the user's wording. */
export class TheoremError extends Error {
  readonly kind: ErrorKind;
  readonly copy?: ErrorCopies;

  constructor(kind: ErrorKind, message: string, options?: TheoremErrorOptions) {
    super(message, options);
    this.name = 'TheoremError';
    this.kind = kind;
    if (options?.copy) this.copy = options.copy;
  }
}
