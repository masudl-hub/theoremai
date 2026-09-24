import { TheoremError } from '../../../src/guardrails/error.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { resolveOpenAiGatewayApiKey } from '../../../src/providers/openrouter/resolve-api-key.ts';

Deno.test('resolveOpenAiGatewayApiKey uses flat apiKey when keySlot is omitted', () => {
  assertEquals(resolveOpenAiGatewayApiKey({ apiKey: ' flat-key ' }, undefined), 'flat-key');
});

Deno.test('resolveOpenAiGatewayApiKey requires apiKey when keySlot is omitted', () => {
  let thrown: unknown;
  try {
    resolveOpenAiGatewayApiKey({}, undefined);
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals(
    (thrown as Error).message,
    'openAiGateway.apiKey is required when keySlot is omitted',
  );
});

Deno.test('resolveOpenAiGatewayApiKey reads vault[keySlot] when set', () => {
  assertEquals(
    resolveOpenAiGatewayApiKey(
      {
        vault: { slotA: 'a', slotB: ' b ', slotC: undefined, paid: 'p' },
        apiKey: 'ignored',
      },
      'slotB',
    ),
    'b',
  );
});

Deno.test('resolveOpenAiGatewayApiKey requires vault when keySlot is set', () => {
  let thrown: unknown;
  try {
    resolveOpenAiGatewayApiKey({ apiKey: 'flat' }, 'slotA');
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as Error).message, 'openAiGateway.vault is required when keySlot is set');
});

Deno.test('resolveOpenAiGatewayApiKey fails closed on empty vault slot', () => {
  let thrown: unknown;
  try {
    resolveOpenAiGatewayApiKey(
      { vault: { slotA: ' ', slotB: undefined, slotC: undefined, paid: undefined } },
      'slotA',
    );
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheoremError, true);
  assertEquals((thrown as TheoremError).kind, 'auth');
});
