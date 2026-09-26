/**
 * Runtime structured-output schema registry.
 *
 * Host apps register schemas by id, then reference those ids from profile output
 * declarations. Each kernel scope owns one registry; see `createKernelScope`.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { StructuredSpec } from '../types.ts';

/** One scope's structured output schemas, by id. */
interface SchemaRegistry {
  /** Register a host-owned structured output schema. */
  register(id: string, spec: StructuredSpec): void;
  /** The schema registered under `id`; throws when there is none. */
  get(id: string): StructuredSpec;
}

/** A schema registry of its own: nothing registered in one is visible from another. */
function createSchemaRegistry(): SchemaRegistry {
  const schemas = new Map<string, StructuredSpec>();
  return {
    register(id, spec) {
      if ('enforced' in spec) {
        throw new TheoremError(
          'config',
          `registerStructured '${id}': enforced was removed; every structured schema is sent to the model as its response format`, // lexicon-exempt: developer contract error
        );
      }
      if (
        !spec.jsonSchema ||
        typeof spec.jsonSchema !== 'object' ||
        Array.isArray(spec.jsonSchema)
      ) {
        throw new TheoremError(
          'config',
          `registerStructured '${id}': jsonSchema must be a JSON Schema object`, // lexicon-exempt: developer contract error
        );
      }
      schemas.set(id, spec);
    },
    get(id) {
      const spec = schemas.get(id);
      if (!spec) {
        throw new TheoremError('config', `Unknown structured schema '${id}'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      }
      return spec;
    },
  };
}

export type { SchemaRegistry };
export { createSchemaRegistry };
