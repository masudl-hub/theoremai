import { DETECTORS, type DetectSpec } from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { thoughtGuardFor } from '../../src/guardrails/thought-guard.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

// A file of its own: the egress automata load once per process, and this file never loads them itself.
Deno.test('a thought guard built for a detector with nothing to read in this turn still loads the automata', async () => {
  const spec: Record<string, unknown> = {};
  for (const detector of DETECTORS) spec[detector] = { at: { thought: 'ignore' } };
  spec.marker_leak = { at: { thought: 'redact' } };
  const guard = await thoughtGuardFor(resolveGuardrailPolicy({ detect: spec as DetectSpec }), {
    stage: 'output_delta',
    trust: 'untrusted',
    profileId: 'chat',
  });
  assertEquals(guard !== undefined, true);
  guard?.push('see <user_data> there');
  guard?.flush();
});
