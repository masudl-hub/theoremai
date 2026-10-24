import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ToolImageLimits } from '../../src/kernel/tools/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = 'iVBORw0KGgo=';
const API = 'https://api.example.com/shots';

function registerShotTool(
  name: string,
  shots: string[],
  blockSecrets = false,
  imageLimits?: ToolImageLimits,
): void {
  registerTool({
    type: 'http',
    name,
    description: 'Returns screenshots by address',
    endpoint: API,
    method: 'GET',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({
      shots: z.array(z.string()),
      note: z.string().optional(),
    }),
    images: (output) => output.shots,
    ...(imageLimits ? { imageLimits } : {}),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: `${name}_bot`,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [name] },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 10 },
        ...(blockSecrets
          ? {
              detect: {
                credentials: { at: { tool_output_http: 'block' as const } },
              },
            }
          : {}),
      },
    }),
  );
  shotsFor.set(name, shots);
}

const shotsFor = new Map<string, string[]>();
const secretFor = new Map<string, string>();

/** The tool's own endpoint answers with its shots; every other address answers from `files`. */
function stubFetch(name: string, files: Record<string, Response>) {
  return ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(API)) {
      return Promise.resolve(
        Response.json({ shots: shotsFor.get(name), note: secretFor.get(name) }),
      );
    }
    const file = files[url];
    return Promise.resolve(file ?? new Response('missing', { status: 404 }));
  }) as typeof fetch;
}

function png(): Response {
  return new Response(PNG, { headers: { 'content-type': 'image/png' } });
}

async function run(name: string, files: Record<string, Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(name, files);
  try {
    return await invokeRegisteredTool({
      profile: `${name}_bot`,
      name,
      input: {},
    });
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('a tool that names a picture hands the model the image, fetched', async () => {
  registerShotTool('shot_ok', ['https://cdn.example.com/a.png']);
  const events = await run('shot_ok', {
    'https://cdn.example.com/a.png': png(),
  });
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.parts, [
    {
      type: 'image',
      mimeType: 'image/png',
      data: PNG_BASE64,
    },
  ]);
  assertEquals(toolEventsOf(events, 'warning'), []);
});

Deno.test('a picture that cannot be fetched is a warning, and the call still completes', async () => {
  registerShotTool('shot_mixed', [
    'https://cdn.example.com/a.png',
    'https://cdn.example.com/notimage',
    'https://cdn.example.com/gone.png',
    'https://10.0.0.5/inside.png',
  ]);
  const events = await run('shot_mixed', {
    'https://cdn.example.com/a.png': png(),
    'https://cdn.example.com/notimage': new Response('<html>', {
      headers: { 'content-type': 'text/html' },
    }),
  });
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.parts?.length, 1);
  const [warning] = toolEventsOf(events, 'warning');
  assertEquals(warning?.warning.code, 'images_unfetched');
  assertStringIncludes(warning?.warning.message ?? '', 'not a png, jpeg, gif or webp image');
  assertStringIncludes(warning?.warning.message ?? '', 'cdn.example.com: HTTP 404');
  assertStringIncludes(warning?.warning.message ?? '', '10.0.0.5');
  assertEquals(toolEventsOf(events, 'error'), []);
});

const SEVEN = Array.from({ length: 7 }, (_, i) => `https://cdn.example.com/${i}.png`);

Deno.test('with no image limits, every picture named is fetched', async () => {
  registerShotTool('shot_all', SEVEN);
  const events = await run('shot_all', Object.fromEntries(SEVEN.map((url) => [url, png()])));
  assertEquals(toolEventsOf(events, 'complete')[0]?.parts?.length, 7);
});

Deno.test('imageLimits.count keeps the first pictures named', async () => {
  registerShotTool('shot_many', SEVEN, false, { count: 4 });
  const events = await run('shot_many', Object.fromEntries(SEVEN.map((url) => [url, png()])));
  assertEquals(toolEventsOf(events, 'complete')[0]?.parts?.length, 4);
});

Deno.test('a picture past imageLimits.bytes is left out', async () => {
  registerShotTool('shot_small', SEVEN.slice(0, 3), false, { bytes: PNG.length - 1 });
  const events = await run('shot_small', Object.fromEntries(SEVEN.map((url) => [url, png()])));
  assertEquals(toolEventsOf(events, 'complete')[0]?.parts ?? [], []);
  assertStringIncludes(
    toolEventsOf(events, 'warning')[0]?.warning.message ?? '',
    `larger than ${PNG.length - 1} bytes`,
  );
});

Deno.test('pictures past imageLimits.totalBytes are left out', async () => {
  registerShotTool('shot_total', SEVEN.slice(0, 3), false, { totalBytes: 2 * PNG_BASE64.length });
  const events = await run('shot_total', Object.fromEntries(SEVEN.map((url) => [url, png()])));
  assertEquals(toolEventsOf(events, 'complete')[0]?.parts?.length, 2);
  assertStringIncludes(toolEventsOf(events, 'warning')[0]?.warning.message ?? '', 'byte total');
});

Deno.test('registration refuses image limits that are not whole numbers, or some time, above 0', () => {
  for (const [limits, field] of [
    [{ count: 0 }, 'imageLimits.count'],
    [{ bytes: 1.5 }, 'imageLimits.bytes'],
    [{ totalBytes: -1 }, 'imageLimits.totalBytes'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
  ] as const) {
    assertThrows(() => registerShotTool('shot_refused', [], false, limits), Error, field);
  }
});

Deno.test('an address that is not https is a warning, not a failed call', async () => {
  registerShotTool('shot_bad', ['not a url', 'http://cdn.example.com/a.png']);
  const events = await run('shot_bad', {});
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.parts, undefined);
  const [warning] = toolEventsOf(events, 'warning');
  assertEquals(warning?.warning.code, 'images_unfetched');
  assertStringIncludes(warning?.warning.message ?? '', 'not an absolute https address');
  assertEquals(toolEventsOf(events, 'error'), []);
});

Deno.test('a result the output guard blocks fetches no pictures', async () => {
  registerShotTool('shot_blocked', ['https://cdn.example.com/a.png'], true);
  secretFor.set('shot_blocked', TEST_OPENAI_KEY);
  let fetched = 0;
  const files = {
    get 'https://cdn.example.com/a.png'() {
      fetched++;
      return png();
    },
  };
  const events = await run('shot_blocked', files);
  assertEquals(fetched, 0);
  assertEquals(toolEventsOf(events, 'error').length, 1);
  assertEquals(toolEventsOf(events, 'complete')[0]?.parts, undefined);
});
