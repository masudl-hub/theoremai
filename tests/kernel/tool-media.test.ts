import '../fixtures/test-host.ts';
import { z } from 'zod';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { MAX_TOOL_MEDIA_FILES } from '../../src/kernel/tools/media-fetch.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BASE64 = 'iVBORw0KGgo=';
const API = 'https://api.example.com/shots';

function registerShotTool(name: string, shots: string[]): void {
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
    output: z.object({ shots: z.array(z.string()) }),
    media: (output) => output.shots,
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
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  shotsFor.set(name, shots);
}

const shotsFor = new Map<string, string[]>();

/** The tool's own endpoint answers with its shots; every other address answers from `files`. */
function stubFetch(name: string, files: Record<string, Response>) {
  return ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(API)) return Promise.resolve(Response.json({ shots: shotsFor.get(name) }));
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
    return await invokeRegisteredTool({ profile: `${name}_bot`, name, input: {} });
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('a tool that names a picture hands the model the image, fetched', async () => {
  registerShotTool('shot_ok', ['https://cdn.example.com/a.png']);
  const events = await run('shot_ok', { 'https://cdn.example.com/a.png': png() });
  const [complete] = toolEventsOf(events, 'complete');
  assertEquals(complete?.parts, [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 }]);
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
  assertEquals(warning?.warning.code, 'media_unfetched');
  assertStringIncludes(warning?.warning.message ?? '', 'not a png, jpeg, gif or webp image');
  assertStringIncludes(warning?.warning.message ?? '', 'cdn.example.com: HTTP 404');
  assertStringIncludes(warning?.warning.message ?? '', '10.0.0.5');
  assertEquals(toolEventsOf(events, 'error'), []);
});

Deno.test('only the first few pictures are fetched', async () => {
  const urls = Array.from(
    { length: MAX_TOOL_MEDIA_FILES + 3 },
    (_, i) => `https://cdn.example.com/${i}.png`,
  );
  registerShotTool('shot_many', urls);
  const events = await run('shot_many', Object.fromEntries(urls.map((url) => [url, png()])));
  assertEquals(toolEventsOf(events, 'complete')[0]?.parts?.length, MAX_TOOL_MEDIA_FILES);
});
