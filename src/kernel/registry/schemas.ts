/**
 * Runtime structured-output schema registry.
 *
 * Host apps register schemas by id, then reference those ids from profile output
 * declarations.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { StructuredSpec } from '../types.ts';

const schemas = new Map<string, StructuredSpec>();

/** Register a host-owned structured output schema. */
function registerStructured(id: string, spec: StructuredSpec): void {
  schemas.set(id, spec);
}

/** Fetch a registered structured output schema or throw a `TheoremError`. */
function getStructured(id: string): StructuredSpec {
  const spec = schemas.get(id);
  if (!spec) {
    throw new TheoremError(`Unknown structured schema '${id}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return spec;
}

export { getStructured, registerStructured };
