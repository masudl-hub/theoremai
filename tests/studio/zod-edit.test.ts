import { assertEquals } from '@std/assert';
import { z } from 'zod';
import { jsonSchemaFromZod } from '../../src/kernel/tools/schema.ts';
import { sourceOrigins } from '../../studio/server/origins.ts';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { applyEdits, planSave, type SaveSubject } from '../../studio/server/save-plan.ts';
import { zodSource } from '../../studio/server/zod-edit.ts';

const ROOT = '/project';

// biome-ignore lint/suspicious/noExplicitAny: a JSON Schema the tests reach into
type Json = Record<string, any>;

/** Three tools as a project writes them: one schema of its own behind a helper, one result they all share. */
const FILES: Record<string, string> = {
  'setup.ts': `import './find.ts';\nimport './load.ts';\nimport './list.ts';\n`,
  'storable.ts': `import type { z } from 'zod';
export function storable<T extends z.ZodType>(schema: T) {
  return schema.refine(() => true);
}
`,
  'result.ts': `import { z } from 'zod';
const textPart = z.object({ type: z.literal('text'), text: z.string() });
export const resultSchema = z.object({
  finding: z.string(),
  parts: z.array(textPart).optional(),
}).passthrough();
`,
  'find.ts': `import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';
import { resultSchema } from './result.ts';
import { storable } from './storable.ts';

const findInput = z.strictObject({
  key: z.string().describe("Where to look."),
  kind: z.enum(['a', 'b']).describe('Which kind.').optional(),
  max: z.number().optional().describe('How many.'),
  prefer: z.array(z.string()).describe('Order.').optional(),
  when: z.string().transform((text) => new Date(text)),
});
type FindInput = z.infer<typeof findInput>;

registerTool({
  name: 'find',
  description: 'Finds.',
  input: storable(findInput),
  output: resultSchema,
  handler: (input: FindInput) => [input],
});
`,
  'list.ts': `import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';
import { resultSchema } from './result.ts';
registerTool({ name: 'list', description: 'Lists.', input: z.object({}), output: resultSchema, handler: () => [] });
`,
  'load.ts': `import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';
import { resultSchema } from './result.ts';
const loadResult = resultSchema.extend({ loaded: z.array(z.string()) });
registerTool({ name: 'load', description: 'Loads.', input: z.object({}), output: loadResult, handler: () => [] });
`,
};

function project(files: Record<string, string> = FILES) {
  const held = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]));
  return readProjectSource(`${ROOT}/setup.ts`, ROOT, (path) => held.get(path));
}

/** `find`'s input as the kernel reads it from the file. */
const INPUT = jsonSchemaFromZod(
  z.strictObject({
    key: z.string().describe('Where to look.'),
    kind: z.enum(['a', 'b']).describe('Which kind.').optional(),
    max: z.number().optional().describe('How many.'),
    prefer: z.array(z.string()).describe('Order.').optional(),
    when: z.string(),
  }),
  'input',
) as Json;

/** The result each tool returns, as the kernel reads it. */
const part = z.object({ type: z.literal('text'), text: z.string() });
const result = z.object({ finding: z.string(), parts: z.array(part).optional() }).passthrough();
const OUTPUT = jsonSchemaFromZod(result, 'output') as Json;
const LOADED = jsonSchemaFromZod(result.extend({ loaded: z.array(z.string()) }), 'output') as Json;

const changed = (schema: Json, change: (schema: Json) => void): Json => {
  const next = structuredClone(schema);
  change(next);
  return next;
};

const subject = (of: string, key: string, before: Json, after: Json): SaveSubject => ({
  kind: 'tool',
  of,
  before: { [key]: before },
  after: { [key]: after },
});

/** Plans the subjects, and returns each change and each line Save adds and takes away, by file. */
function saved(subjects: SaveSubject[], files: Record<string, string> = FILES) {
  const plan = planSave(project(files), subjects);
  const lines: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const edits = plan.edits.filter((edit) => edit.file === `${ROOT}/${file}`);
    if (!edits.length) continue;
    const [was, now] = [text.split('\n'), applyEdits(text, edits).split('\n')];
    for (const line of was) if (!now.includes(line)) lines.push(`${file} - ${line.trim()}`);
    for (const line of now) if (!was.includes(line)) lines.push(`${file} + ${line.trim()}`);
  }
  const changes = plan.changes.map((change) => {
    const at = `${change.file?.replace(`${ROOT}/`, '') ?? ''}:${String(change.line ?? '')}`;
    const shared = change.sharedWith ? ` | ${change.sharedWith.join(',')}` : '';
    return `${change.of} ${change.setting}: ${change.status} ${at}${shared}`;
  });
  return { changes, lines };
}

const input = (change: (schema: Json) => void) =>
  saved([subject('find', 'inputSchema', INPUT, changed(INPUT, change))]);

Deno.test('a description is changed where the field writes it, through the helper and the constant', () => {
  assertEquals(
    input((schema) => {
      schema.properties.key.description = 'Where to find "it".';
    }),
    {
      changes: ['find inputSchema.properties.key.description: written find.ts:7'],
      lines: [
        'find.ts - key: z.string().describe("Where to look."),',
        'find.ts + key: z.string().describe("Where to find \\"it\\"."),',
      ],
    },
  );
});

Deno.test('a description is added after the schema and taken away with its call', () => {
  const { changes, lines } = input((schema) => {
    schema.description = 'Finds things.';
    delete schema.properties.max.description;
  });
  assertEquals(changes, [
    'find inputSchema.description: written find.ts:18',
    'find inputSchema.properties.max.description: written find.ts:9',
  ]);
  assertEquals(lines, [
    "find.ts - max: z.number().optional().describe('How many.'),",
    'find.ts - input: storable(findInput),',
    'find.ts + max: z.number().optional(),',
    "find.ts + input: storable(findInput).describe('Finds things.'),",
  ]);
});

Deno.test('the values of an enum are changed in its list', () => {
  assertEquals(
    input((schema) => {
      schema.properties.kind.enum = ['a', 'b', 'c'];
    }).lines,
    [
      "find.ts - kind: z.enum(['a', 'b']).describe('Which kind.').optional(),",
      "find.ts + kind: z.enum(['a', 'b', 'c']).describe('Which kind.').optional(),",
    ],
  );
});

Deno.test('a field is made needed or left out with `.optional()`, wherever the call stands', () => {
  const { changes, lines } = input((schema) => {
    schema.required = ['kind', 'max', 'when'];
  });
  assertEquals(changes, [
    'find inputSchema.required.key: written find.ts:7',
    'find inputSchema.required.kind: written find.ts:8',
    'find inputSchema.required.max: written find.ts:9',
  ]);
  assertEquals(lines, [
    'find.ts - key: z.string().describe("Where to look."),',
    "find.ts - kind: z.enum(['a', 'b']).describe('Which kind.').optional(),",
    "find.ts - max: z.number().optional().describe('How many.'),",
    'find.ts + key: z.string().describe("Where to look.").optional(),',
    "find.ts + kind: z.enum(['a', 'b']).describe('Which kind.'),",
    "find.ts + max: z.number().describe('How many.'),",
  ]);
});

Deno.test('a field is added as Zod and taken away with its line', () => {
  const { changes, lines } = input((schema) => {
    schema.properties.limit = { type: 'integer', minimum: 1, maximum: 10, description: 'Most.' };
    schema.properties.where = {
      type: 'object',
      properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      required: ['lat', 'lon'],
      additionalProperties: false,
    };
    schema.required = ['key', 'when', 'where'];
    delete schema.properties.prefer;
  });
  assertEquals(changes, [
    'find inputSchema.properties.prefer: written find.ts:10',
    'find inputSchema.properties.limit: written find.ts:6',
    'find inputSchema.properties.where: written find.ts:6',
  ]);
  assertEquals(lines, [
    "find.ts - prefer: z.array(z.string()).describe('Order.').optional(),",
    "find.ts + limit: z.int().min(1).max(10).describe('Most.').optional(),",
    'find.ts + where: z.strictObject({',
    'find.ts + lat: z.number(),',
    'find.ts + lon: z.number(),',
    'find.ts + }),',
  ]);
});

Deno.test('a field written out in full is written again when its kind changes; one only code can say is left', () => {
  const { changes, lines } = input((schema) => {
    schema.properties.max = { type: 'integer', minimum: 1, description: 'How many.' };
    schema.properties.when.description = 'When.';
  });
  assertEquals(changes, [
    'find inputSchema.properties.max: written find.ts:9',
    // `.transform()` is code: the review names its line.
    'find inputSchema.properties.when: code find.ts:11',
  ]);
  assertEquals(lines, [
    "find.ts - max: z.number().optional().describe('How many.'),",
    "find.ts + max: z.int().min(1).describe('How many.').optional(),",
  ]);
});

Deno.test('whether an object takes other fields is the call it starts from', () => {
  assertEquals(
    input((schema) => {
      delete schema.additionalProperties;
    }),
    {
      changes: ['find inputSchema.additionalProperties: written find.ts:6'],
      lines: [
        'find.ts - const findInput = z.strictObject({',
        'find.ts + const findInput = z.object({',
      ],
    },
  );
  const closed = changed(OUTPUT, (schema) => {
    schema.additionalProperties = false;
  });
  const all = ['find', 'list'].map((of) => subject(of, 'outputSchema', OUTPUT, closed));
  const loads = subject(
    'load',
    'outputSchema',
    LOADED,
    changed(LOADED, (schema) => {
      schema.additionalProperties = false;
    }),
  );
  assertEquals(saved([...all, loads]).lines, ['result.ts - }).passthrough();', 'result.ts + });']);
});

Deno.test('a schema tools share is written once each of them makes the change, and waits until then', () => {
  const told = (schema: Json) => {
    schema.properties.finding.description = 'What it found.';
  };
  const one = saved([subject('find', 'outputSchema', OUTPUT, changed(OUTPUT, told))]);
  assertEquals(one, {
    changes: ['find outputSchema.properties.finding.description: constant result.ts:4 | load,list'],
    lines: [],
  });
  const all = saved([
    subject('find', 'outputSchema', OUTPUT, changed(OUTPUT, told)),
    subject('list', 'outputSchema', OUTPUT, changed(OUTPUT, told)),
    // The tool that extends the shared schema holds the same field.
    subject('load', 'outputSchema', LOADED, changed(LOADED, told)),
  ]);
  assertEquals(
    all.changes,
    ['find', 'list', 'load'].map(
      (of) => `${of} outputSchema.properties.finding.description: written result.ts:4`,
    ),
  );
  assertEquals(all.lines, [
    'result.ts - finding: z.string(),',
    "result.ts + finding: z.string().describe('What it found.'),",
  ]);
});

Deno.test('a field an extended schema adds is its own', () => {
  const after = changed(LOADED, (schema) => {
    schema.properties.loaded.description = 'Each one loaded.';
    schema.properties.count = { type: 'number' };
    schema.required = ['finding', 'loaded', 'count'];
  });
  assertEquals(saved([subject('load', 'outputSchema', LOADED, after)]), {
    changes: [
      'load outputSchema.properties.loaded.description: written load.ts:4',
      'load outputSchema.properties.count: written load.ts:4',
    ],
    lines: [
      'load.ts - const loadResult = resultSchema.extend({ loaded: z.array(z.string()) });',
      "load.ts + const loadResult = resultSchema.extend({ loaded: z.array(z.string()).describe('Each one loaded.'), count: z.number() });",
    ],
  });
});

Deno.test('what Save adds is quoted as the file quotes, and a list on one line stays on one', () => {
  const files = {
    'setup.ts': `import { registerTool } from "@theoremjs/agents";
import { z } from "zod";
const input = z.strictObject({
  kind: z.enum(["nursery", "garden_center", "hardware_store", "any"]).optional(),
});
registerTool({ name: "list", description: "Lists.", input, handler: () => [] });
`,
  };
  const kinds = ['nursery', 'garden_center', 'hardware_store', 'any'];
  const before = {
    type: 'object',
    properties: { kind: { type: 'string', enum: kinds } },
    additionalProperties: false,
  };
  const after = changed(before, (schema) => {
    schema.properties.kind.enum.push('florist');
    schema.properties.near = { type: 'string', description: 'Where.' };
  });
  assertEquals(saved([subject('list', 'inputSchema', before, after)], files).lines, [
    'setup.ts - kind: z.enum(["nursery", "garden_center", "hardware_store", "any"]).optional(),',
    'setup.ts + kind: z.enum(["nursery", "garden_center", "hardware_store", "any", "florist"]).optional(),',
    'setup.ts + near: z.string().describe("Where.").optional(),',
  ]);
});

Deno.test('a field that can be null keeps its description open', () => {
  const files = {
    'setup.ts': `import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';
const input = z.object({ note: z.string().nullable().describe('A note.') });
registerTool({ name: 'list', description: 'Lists.', input, handler: () => [] });
`,
  };
  const before = jsonSchemaFromZod(
    z.object({ note: z.string().nullable().describe('A note.') }),
    'input',
  ) as Json;
  const after = changed(before, (schema) => {
    schema.properties.note.description = 'Any note.';
  });
  assertEquals(saved([subject('list', 'inputSchema', before, after)], files), {
    changes: ['list inputSchema.properties.note.description: written setup.ts:3'],
    lines: [
      "setup.ts - const input = z.object({ note: z.string().nullable().describe('A note.') });",
      "setup.ts + const input = z.object({ note: z.string().nullable().describe('Any note.') });",
    ],
  });
});

Deno.test('a schema that is not Zod the studio follows is left for code', () => {
  const files = {
    'setup.ts': `import { registerTool } from '@theoremjs/agents';
import { schemaFor } from 'some-package';
registerTool({ name: 'list', description: 'Lists.', input: schemaFor('list'), handler: () => [] });
`,
  };
  const before = { type: 'object', properties: {} };
  const plan = saved(
    [subject('list', 'inputSchema', before, { ...before, description: 'Lists.' })],
    files,
  );
  assertEquals(plan, { changes: ['list inputSchema: code setup.ts:3'], lines: [] });
  assertEquals(
    sourceOrigins(project(files)).tools.list?.map(
      (origin) => `${origin.path.join('.')} ${origin.kind}`,
    ),
    ['handler code', 'inputSchema code'],
  );
});

Deno.test('a schema in Zod is open, and each constant it is written in is a place tools may share', () => {
  const origins = sourceOrigins(project());
  assertEquals(
    origins.tools.find?.map((origin) => origin.path.join('.')),
    ['handler'],
  );
  const places = (tool: string) =>
    origins.sites?.tools[tool]?.map(
      (site) =>
        `${site.path.join('.')} | ${site.name ?? ''} | ${String(site.shared)} | ${String(site.site)}`,
    );
  assertEquals(places('find'), [
    'outputSchema | resultSchema | true | 2',
    'outputSchema.properties.parts.items | textPart | true | 3',
  ]);
  // What the extension adds is the tool's own, inside the schema it shares.
  assertEquals(places('load'), [
    'outputSchema | resultSchema | true | 2',
    'outputSchema.properties.parts.items | textPart | true | 3',
    'outputSchema.properties.loaded | loadResult | false | 6',
    'outputSchema.required | loadResult | false | 7',
  ]);
});

/** The Zod the studio wrote, run, as the kernel reads it. */
function reads(text: string, side: 'input' | 'output'): unknown {
  const field = new Function('z', `return ${text};`)(z) as z.ZodType;
  return (jsonSchemaFromZod(z.object({ field }), side) as Json).properties.field;
}

Deno.test('the Zod the studio writes reads back as the schema it was written from', () => {
  const schemas: Json[] = [
    { type: 'string', description: 'It\'s "here".' },
    { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z]+$' },
    { type: 'string', enum: ['a', 'b'] },
    { type: 'string', const: 'text' },
    { type: 'number', minimum: 0, maximum: 1 },
    { type: 'number', exclusiveMinimum: 0, multipleOf: 2 },
    { type: 'boolean', default: false },
    { type: ['string', 'null'] },
    { type: ['string', 'number'] },
    { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 },
    { type: 'string', format: 'uri' },
    {},
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name.' },
        tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
        place: {
          type: 'object',
          properties: { lat: { type: 'number' } },
          required: ['lat'],
          additionalProperties: {},
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'number' } },
    {
      anyOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        { type: 'string' },
      ],
    },
  ];
  for (const schema of schemas) {
    // A field with a default can be left out, so it is written as one that can.
    const text = zodSource(schema, 'default' in schema, 'input', 'z');
    assertEquals(
      text === undefined ? undefined : reads(text, 'input'),
      schema,
      JSON.stringify(schema),
    );
  }
  // An integer gains its bounds when Zod reads it, as it does when the studio runs it.
  assertEquals(zodSource({ type: 'integer' }, true, 'input', 'z'), 'z.int().optional()');
  // A tool's result is read closed, so a plain object says so there.
  const closed = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
    additionalProperties: false,
  };
  assertEquals(zodSource(closed, false, 'output', 'zod'), 'zod.object({\n  a: zod.string(),\n})');
  assertEquals(reads('z.object({ a: z.string() })', 'output'), closed);
});

Deno.test('a schema the studio has no Zod for is not written', () => {
  for (const schema of [
    { type: 'string', format: 'date' },
    { not: { type: 'string' } },
    { type: 'string', format: 'email', pattern: 'x' },
  ]) {
    assertEquals(zodSource(schema, false, 'input', 'z'), undefined);
  }
});
