import { fuzzGuardrailsCommand } from '../../src/cli/commands/fuzz-guardrails.ts';
import { runInboundGuardrailFuzz } from '../../src/guardrails/corpus/fuzz-inbound.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('runInboundGuardrailFuzz catches all expected adversarial inbound payloads', () => {
  const ok = runInboundGuardrailFuzz({ quiet: true });
  assertEquals(ok, true);
});

Deno.test('fuzzGuardrailsCommand returns true on clean corpus', () => {
  const ok = fuzzGuardrailsCommand();
  assertEquals(ok, true);
});
