import { type ZodType, z } from 'zod';
import { DEMO_HTTP_SAMPLE_INPUT, demoToolSpecs } from '../../playground/concierge-demo.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/execute.ts';
import { registerTool, resetTools } from '../../src/kernel/tools/registry.ts';
import type { Profile } from '../../src/kernel/types.ts';

function jsonSchemaFields(schema: Record<string, unknown>): {
  props: Record<string, Record<string, unknown>>;
  required: Set<string>;
} {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [],
  );
  return { props, required };
}

function propToZod(prop: Record<string, unknown>): ZodType {
  const t = prop.type;
  if (t === 'string' || (Array.isArray(t) && t.includes('string'))) return z.string();
  if (t === 'number' || t === 'integer') return z.number();
  if (t === 'boolean') return z.boolean();
  if (t === 'array') {
    const items = prop.items;
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      return z.array(propToZod(items as Record<string, unknown>));
    }
    return z.array(z.unknown());
  }
  if (t === 'object' || prop.properties) {
    return zodFromJsonSchema(prop);
  }
  return z.unknown();
}

function zodFromJsonSchema(schema: Record<string, unknown>): ZodType {
  if (schema.type === 'array') {
    return propToZod(schema);
  }
  const { props, required } = jsonSchemaFields(schema);
  const shape: Record<string, ZodType> = {};
  for (const [key, prop] of Object.entries(props)) {
    const field = propToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  if (Object.keys(shape).length === 0) {
    return z.looseObject({});
  }
  return z.looseObject(shape);
}

const profile: Profile = {
  id: 'demo',
  type: 'text',
  identity: { handle: 'concierge' },
  models: {
    default: { protocol: 'openAi', provider: 'openrouter', apiId: 'test' },
  },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: {},
  guardrails: {
    network: {
      allowedHosts: [
        'geocoding-api.open-meteo.com',
        'nominatim.openstreetmap.org',
        'api.open-meteo.com',
        'api.sunrise-sunset.org',
        'api.frankfurter.app',
        'api.frankfurter.dev',
        'en.wikipedia.org',
        'archive.org',
        'api.zippopotam.us',
        'pokeapi.co',
        'catfact.ninja',
        'official-joke-api.appspot.com',
        'api.adviceslip.com',
        'dog.ceo',
      ],
    },
  },
};

const SAMPLE_INPUT = DEMO_HTTP_SAMPLE_INPUT;

function parseCsv(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function registerDemoHttpTools(): string[] {
  resetTools();
  const names: string[] = [];
  for (const seed of demoToolSpecs()) {
    const data = seed.data;
    if (data.toolType !== 'http') continue;
    const endpoint = data.endpoint?.trim();
    if (!endpoint) {
      throw new Error(`HTTP demo tool ${data.toolName} is missing endpoint`);
    }
    names.push(data.toolName);
    registerTool({
      type: 'http',
      name: data.toolName,
      description: data.description,
      category: data.category,
      access: data.access,
      permission: data.permission,
      loadTier: data.loadTier,
      paths: parseCsv(data.paths).length ? parseCsv(data.paths) : ['*'],
      endpoint,
      method: data.method ?? 'GET',
      headers: data.headersJson ? JSON.parse(data.headersJson) : undefined,
      mapping: {
        pathParams: parseCsv(data.pathParams).length ? parseCsv(data.pathParams) : undefined,
        queryParams: parseCsv(data.queryParams).length ? parseCsv(data.queryParams) : undefined,
        bodyParam: data.bodyParam?.trim() || undefined,
      },
      input: zodFromJsonSchema(JSON.parse(data.inputJson)),
      output: zodFromJsonSchema(JSON.parse(data.outputJson)),
    });
  }
  return names;
}

Deno.test('travel concierge HTTP tools execute against live APIs', async () => {
  const names = registerDemoHttpTools();
  profile.tools.allow = names;
  const failures: string[] = [];

  for (const name of names) {
    const input = SAMPLE_INPUT[name] ?? {};
    const exec = executeRegisteredTool({
      profile,
      name,
      input,
      callId: `smoke-${name}`,
      ctx: {},
    });
    let ok = false;
    let detail = 'no events';
    for await (const ev of exec) {
      if (ev.type !== 'tool') continue;
      if (ev.tool?.phase === 'complete') {
        ok = true;
        break;
      }
      if (ev.tool?.phase === 'error' && ev.tool.failure) {
        detail = `${ev.tool.failure.code}: ${ev.tool.failure.message}`;
        break;
      }
    }
    if (!ok) failures.push(`${name}: ${detail}`);
    // Nominatim rate limit
    if (name === 'search_places' || name === 'reverse_geocode') {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  if (failures.length) {
    throw new Error(`HTTP demo tool failures:\n${failures.join('\n')}`);
  }
});
