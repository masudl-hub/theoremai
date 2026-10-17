import { z } from 'zod';
import { getProfile, registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { resolveTurnTools } from '../../src/kernel/tools/resolve.ts';
import { jsonSchemaFromZod } from '../../src/kernel/tools/schema.ts';
import { geminiModels } from '../fixtures/models.ts';

Deno.test('jsonSchemaFromZod preserves tool parameter shape for Zod 4 schemas', () => {
  const schema = z.object({
    orderId: z.string(),
    count: z.number().optional(),
    tags: z.array(z.string()).min(1),
    role: z.enum(['read', 'write']),
    note: z.string().describe('Operator note'),
    nested: z.object({ sensor: z.string() }),
  });

  assertEquals(jsonSchemaFromZod(schema, 'input'), {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      count: { type: 'number' },
      tags: {
        minItems: 1,
        type: 'array',
        items: { type: 'string' },
      },
      role: { type: 'string', enum: ['read', 'write'] },
      note: { type: 'string', description: 'Operator note' },
      nested: {
        type: 'object',
        properties: {
          sensor: { type: 'string' },
        },
        required: ['sensor'],
      },
    },
    required: ['orderId', 'tags', 'role', 'note', 'nested'],
  });
});

Deno.test('jsonSchemaFromZod keeps JSON Schema no single provider subset allows', () => {
  const node: z.ZodType<unknown> = z.lazy(() =>
    z.object({ name: z.string(), children: z.array(node).optional() }),
  );
  const wire = jsonSchemaFromZod(
    z.object({ kind: z.literal('a'), note: z.string().nullable(), tree: node.optional() }),
    'input',
  );

  assertEquals(Object.hasOwn(wire, '$schema'), false);
  assertEquals(wire.properties, {
    kind: { type: 'string', const: 'a' },
    note: { type: ['string', 'null'] },
    tree: { allOf: [{ $ref: '#/definitions/__schema0' }] },
  });
  assertEquals(Object.keys(wire.definitions as object), ['__schema0']);
});

Deno.test('jsonSchemaFromZod input mode keeps defaulted tool args out of required', () => {
  const schema = z.object({
    q: z.string().default('all'),
    limit: z.number().optional(),
  });

  assertEquals(jsonSchemaFromZod(schema, 'input').required, undefined);
  assertEquals(jsonSchemaFromZod(schema, 'output').required, ['q']);
});

Deno.test('registerTool wire snapshot preserves Zod input properties', () => {
  const toolName = 'wire_schema_pressure_probe';
  registerTool({
    type: 'function',
    name: toolName,
    description: 'Wire schema pressure probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ q: z.string() }),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerProfile(
    defineProfile({
      id: 'wire_schema_pressure_bot',
      type: 'text',
      identity: { handle: 'wire-schema-pressure' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [toolName] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 1 } },
    }),
  );

  const profile = getProfile('wire_schema_pressure_bot');
  const snapshot = resolveTurnTools(
    defaultKernelScope.tools,
    profile,
    { profile: 'wire_schema_pressure_bot', input: { text: 'x' } },
    'gemini35FlashLite',
  );
  const wire = snapshot.wire.find((entry) => entry.name === toolName);
  const parameters = wire?.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  assertEquals(parameters?.properties?.q, { type: 'string' });
  assertEquals(parameters?.required, ['q']);
});
