import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { loadedModules, runImportProbe, stdoutBeforeMarker } from '../fixtures/run-import-probe.ts';

Deno.test('createProvider subprocess does not load adapters until complete', async () => {
  const result = await runImportProbe('./probes/create-provider-load.ts');
  if (result.code !== 0) {
    throw new Error(result.stderr || `probe exited ${result.code}`);
  }

  const beforeComplete = loadedModules(
    stdoutBeforeMarker(result.stdout, 'PHASE:after-local-complete'),
  );
  assertEquals(beforeComplete, []);

  const afterComplete = loadedModules(result.stdout);
  assertEquals(afterComplete.includes('local-adapter'), true);
  assertEquals(afterComplete.includes('openrouter-chat'), false);
  assertEquals(afterComplete.includes('google-interactions-adapter'), false);
  assertEquals(afterComplete.includes('openrouter-speech'), false);
  assertEquals(result.stdout.includes('PROBE_DONE'), true);
});
