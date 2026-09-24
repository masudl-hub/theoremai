import {
  DEMO_ALLOWED_HOSTS,
  DEMO_HTTP_SAMPLE_INPUT,
  demoToolSpecs,
} from '../../playground/concierge-demo.ts';
import { zodFromJsonSchema } from '../../playground/tool-schema.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/execute.ts';
import { registerTool, resetTools } from '../../src/kernel/tools/registry.ts';
import type { Profile } from '../../src/kernel/types.ts';

const profile: Profile = {
  id: 'demo',
  type: 'text',
  identity: { handle: 'concierge' },
  models: {
    default: { protocol: 'openAi', provider: 'openrouter', apiId: 'test' },
  },
  defaultModel: 'default',
  tools: { allow: [] },
  inputs: { text: true },
  outputs: {},
  guardrails: {
    network: {
      allowedHosts: DEMO_ALLOWED_HOSTS.split(',').map((host) => host.trim()),
    },
  },
};

const SAMPLE_INPUT = DEMO_HTTP_SAMPLE_INPUT;

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
      paths: data.paths.length ? data.paths : ['*'],
      endpoint,
      method: data.method ?? 'GET',
      headers: data.headersJson ? JSON.parse(data.headersJson) : undefined,
      mapping: {
        pathParams: data.pathParams?.length ? data.pathParams : undefined,
        queryParams: data.queryParams?.length ? data.queryParams : undefined,
        bodyParam: data.bodyParam?.trim() || undefined,
      },
      input: zodFromJsonSchema(JSON.parse(data.inputJson)),
      output: zodFromJsonSchema(JSON.parse(data.outputJson)),
    });
  }
  return names;
}

Deno.test({
  name: 'travel concierge HTTP tools execute against live APIs',
  ignore: Deno.env.get('CI') === 'true' || Deno.env.get('GITHUB_ACTIONS') === 'true',
  fn: async () => {
    const names = registerDemoHttpTools();
    profile.tools.allow = names;
    const failures: string[] = [];

    for (const name of names) {
      const input = SAMPLE_INPUT[name] ?? {};
      let ok = false;
      let detail = 'no events';

      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        const exec = executeRegisteredTool({
          profile,
          name,
          input,
          callId: `smoke-${name}-${attempt}`,
          ctx: {},
        });
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
  },
});
