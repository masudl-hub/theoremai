import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { detects } from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { getProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';

Deno.test('chat fixture resolves canary on and binds into system', async () => {
  const policy = resolveGuardrailPolicy(getProfile('chat').guardrails);
  assertEquals(detects(policy.detect, 'canary_leak'), true);

  let system = '';
  async function* fake(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'text', text: 'hi' };
  }
  const wrap: ModelProvider = {
    async *complete(req: ProviderCompleteRequest) {
      system = req.system ?? '';
      yield* fake();
    },
  };
  for await (const _ of runTurn({ profile: 'chat', input: { text: 'hi' } }, wrap)) {
    // drain
  }
  assertEquals(system.includes('Your canary token is'), true);
});
