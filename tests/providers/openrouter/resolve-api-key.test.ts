import { TheoremError } from '../../../src/guardrails/error.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { resolveOpenAiGatewayApiKey } from '../../../src/providers/openrouter/resolve-api-key.ts';

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

Deno.test('resolveOpenAiGatewayApiKey refuses a model that names no vault slot', () => {
  const thrown = thrownBy(() => resolveOpenAiGatewayApiKey({ vault: { slot_a: 'a' } }, undefined));
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as TheoremError).kind, 'auth');
  assertEquals((thrown as Error).message, 'an OpenRouter model must name a vault slot');
});

Deno.test('resolveOpenAiGatewayApiKey refuses a missing slot even with no vault at all', () => {
  const thrown = thrownBy(() => resolveOpenAiGatewayApiKey({}, undefined));
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as Error).message, 'an OpenRouter model must name a vault slot');
});

Deno.test('resolveOpenAiGatewayApiKey reads vault[keySlot] when set', () => {
  assertEquals(
    resolveOpenAiGatewayApiKey({ vault: { slot_a: 'a', slot_b: ' b ', slot_c: 'c' } }, 'slot_b'),
    'b',
  );
});

Deno.test('resolveOpenAiGatewayApiKey needs the slot in the vault when keySlot is set', () => {
  const thrown = thrownBy(() => resolveOpenAiGatewayApiKey({ vault: { slot_b: 'b' } }, 'slot_a'));
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as Error).message, "the vault has no key in slot 'slot_a'");
});

Deno.test('resolveOpenAiGatewayApiKey needs a vault when keySlot is set', () => {
  const thrown = thrownBy(() => resolveOpenAiGatewayApiKey({}, 'slot_a'));
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as Error).message, "the vault has no key in slot 'slot_a'");
});

Deno.test('resolveOpenAiGatewayApiKey fails closed on empty vault slot', () => {
  const thrown = thrownBy(() => resolveOpenAiGatewayApiKey({ vault: { slot_a: ' ' } }, 'slot_a'));
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as TheoremError).kind, 'auth');
});
