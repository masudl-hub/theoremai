import { TheoremError } from '../../guardrails/error.ts';
import type { StructuredSpec } from '../types.ts';

interface SchemaRegistry {
  register(id: string, spec: StructuredSpec): void;
  /** Throws when there is none. */
  get(id: string): StructuredSpec;
  find(id: string): StructuredSpec | undefined;
}

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
    find: (id) => schemas.get(id),
  };
}

export type { SchemaRegistry };
export { createSchemaRegistry };
