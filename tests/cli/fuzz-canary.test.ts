import { assertEquals } from '@std/assert';
import { runCanaryFuzz } from '../../src/cli/commands/fuzz-canary.ts';

/** Leak shapes the scan does not detect yet; each is a bypass until it does. */
const UNDETECTED: string[] = [];

Deno.test('fuzz-canary catches every other leak on both channels, with no false alarms', async () => {
  const results = await runCanaryFuzz();
  assertEquals(
    results.filter((r) => r.falseAlarm).map((r) => r.attack.name),
    [],
  );
  const bypassed = [...new Set(results.filter((r) => r.bypassed).map((r) => r.attack.name))];
  assertEquals(bypassed.sort(), [...UNDETECTED].sort());
  for (const name of UNDETECTED) {
    assertEquals(results.filter((r) => r.attack.name === name && r.bypassed).length, 2);
  }
});
