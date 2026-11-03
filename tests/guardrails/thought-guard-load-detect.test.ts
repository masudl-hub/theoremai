import { DETECTORS, type DetectSpec } from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { thoughtGuardFor } from '../../src/guardrails/thought-guard.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

// A file of its own: the egress automata load once per process, and this file never loads them itself.
Deno.test('a thought read only by a detector that omits nothing still loads the automata it streams through', async () => {
  const spec: Record<string, unknown> = {};
  for (const detector of DETECTORS) spec[detector] = { at: { thought: 'ignore' } };
  spec.ids = { at: { thought: 'flag' } };
  const guard = await thoughtGuardFor(resolveGuardrailPolicy({ detect: spec as DetectSpec }), {
    stage: 'output_delta',
    trust: 'untrusted',
    profileId: 'chat',
  });
  assertEquals(guard !== undefined, true);
  guard?.push('reach me at ana@example.com today');
  guard?.flush();
});
