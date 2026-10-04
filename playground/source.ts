/**
 * One serializer writes the values, and each tool's schemas as the Zod expressions
 * `zodFromJsonSchema` would build.
 */

import type { CompiledPlayground } from './compile.ts';
import type { ToolRegistration } from './registrations.ts';
import { stubOutputFromSchema } from './stub.ts';
import { keySource, quoteSource, zodExprFromJsonSchema } from './tool-schema.ts';

/** Source text written as-is into the module. */
class Expr {
  constructor(readonly code: string) {}
}

/** Arrays of primitives shorter than this stay on one line. */
const INLINE_ARRAY_WIDTH = 60;

function literal(value: unknown, depth: number): string {
  if (value instanceof Expr) return value.code;
  if (typeof value === 'string') return quoteSource(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const items = value.map((item) => literal(item, depth + 1));
    const inline = `[${items.join(', ')}]`;
    const primitive = value.every((item) => item === null || typeof item !== 'object');
    if (primitive && inline.length <= INLINE_ARRAY_WIDTH) return inline;
    return `[\n${items.map((item) => `${pad}${item},`).join('\n')}\n${close}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';
    const lines = entries.map(([key, item]) =>
      `${pad}${keySource(key)}: ${literal(item, depth + 1)},`
    );
    return `{\n${lines.join('\n')}\n${close}}`;
  }
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`Playground source cannot write a ${typeof value} value.`);
}

function toolSource(tool: ToolRegistration): string {
  const { inputSchema, outputSchema, ...fields } = tool;
  // The kernel fixes an agent tool's schemas.
  if (fields.type === 'agent') return `registerTool(${literal(fields, 0)});\n`;
  const zod = {
    input: new Expr(zodExprFromJsonSchema(inputSchema, 1)),
    output: new Expr(zodExprFromJsonSchema(outputSchema, 1)),
  };
  if (fields.type !== 'function') return `registerTool(${literal({ ...fields, ...zod }, 0)});\n`;
  const { stubResponse, ...functionFields } = fields;
  const stub = stubResponse ?? stubOutputFromSchema(outputSchema);
  const handler = new Expr(`() => Promise.resolve(${literal(stub, 1)})`);
  return `registerTool(${literal({ ...functionFields, ...zod, handler }, 0)});\n`;
}

export function playgroundSource(compiled: CompiledPlayground): string {
  const { profile, customTools, structured } = compiled;
  const imports = [
    'defineProfile',
    'registerProfile',
    ...(structured ? ['registerStructured'] : []),
    ...(customTools.length ? ['registerTool'] : []),
  ];
  const blocks = [
    [
      ...(customTools.length ? [`import { z } from 'zod';`] : []),
      `import {\n${
        [...(compiled.questions ? ['type DecisionQuestion'] : []), ...imports]
          .map((name) => `  ${name},`).join('\n')
      }\n} from '@theoremjs/agents';\n`,
    ].join('\n'),
    ...customTools.map(toolSource),
    ...(structured
      ? [`registerStructured(${quoteSource(structured.id)}, ${literal(structured.spec, 0)});\n`]
      : []),
    `const profile = defineProfile(${literal(profile, 0)});\n\nregisterProfile(profile);\n`,
    ...(compiled.questions
      ? [
        `/** What every decision asks about the state, by id. */\nconst questions = ${
          literal(compiled.questions, 0)
        } satisfies Record<string, DecisionQuestion>;\n`,
      ]
      : []),
  ];
  return blocks.join('\n');
}
