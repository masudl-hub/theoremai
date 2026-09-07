import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { buildRecord } from '../../src/observability/trace-record.ts';
import '../fixtures/test-host.ts';

Deno.test('trace-attach has no eager google/interactions import', async () => {
  const src = await Deno.readTextFile(
    new URL('../../src/observability/trace-attach.ts', import.meta.url),
  );
  assertEquals(/from\s+['"].*google\/interactions\/.*['"]/.test(src), false);
  assertEquals(src.includes("import('../providers/google/interactions/framing.ts')"), true);
});

Deno.test('trace-attach attaches wire only for geminiInteractions', async () => {
  const { generation } = resolveTurn({ profile: 'chat', input: { text: 'probe' } });
  const base = {
    req: { profile: 'chat', input: { text: 'probe' } },
    events: [{ type: 'text' as const, text: 'ok' }],
    started: Date.now(),
    system: 'probe system',
    generation,
    upstreamLog: [],
  };

  const openAi = await buildRecord({ ...base, protocol: 'openAi' });
  assertEquals(openAi.wire, undefined);

  const gemini = await buildRecord({ ...base, protocol: 'geminiInteractions' });
  assertEquals(gemini.wire !== undefined, true);
});
