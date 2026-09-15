/**
 * Contract-failure error class for THEORUM.
 *
 * Lives in its own module so `lexicon.ts` can throw it without importing
 * `error.ts` (which resolves public copy through the lexicon).
 *
 * @module
 */

/** Error class used for expected THEORUM contract failures. */
export class TheorumError extends Error {
  constructor(message = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TheorumError';
  }
}
