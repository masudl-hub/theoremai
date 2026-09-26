import type { TheoremError } from '../../mod.ts';

/** `parseLiveServerEnvelope`'s report for a test that sends no malformed event: one fails the test. */
export function neverMalformed(error: TheoremError): never {
  throw error;
}
