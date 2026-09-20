/**
 * Contract-failure error class for THEOREM.
 *
 * Lives in its own module so `lexicon.ts` can throw it without importing
 * `error.ts` (which resolves public copy through the lexicon).
 *
 * @module
 */

/** Error class used for expected THEOREM contract failures. */
export class TheoremError extends Error {
  constructor(message = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TheoremError';
  }
}
