import { assertEquals } from '@std/assert';
import { fuzzCanaryCommand } from '../../src/cli/commands/fuzz-canary.ts';

Deno.test('fuzz-canary blocks all synthetic leak attempts with no false alarms', async () => {
  const ok = await fuzzCanaryCommand();
  assertEquals(ok, true);
});
