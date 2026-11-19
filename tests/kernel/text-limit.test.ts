import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { profileTypesForField } from '../../src/kernel/profile-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ProfileInputsSpec, TurnModel } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';
import { TAKE_OUT_INBOUND } from '../fixtures/take-out.ts';

function define(id: string, inputs: ProfileInputsSpec, detect?: typeof TAKE_OUT_INBOUND): void {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs,
      identity: { handle: id, system: 'sys' },
      ...(detect ? { guardrails: { detect } } : {}),
    }),
  );
}

/** Runs one turn; returns the text the model was sent, or the refusal the kernel threw. */
async function turn(
  profile: string,
  text: string,
): Promise<{ sent: string | null; error?: TheoremError }> {
  let sent: string | null = null;
  const provider: TurnModel = {
    async *complete(req) {
      await Promise.resolve();
      sent = req.history?.at(-1)?.content ?? '';
      yield { type: 'text', text: 'ok' };
    },
  };
  try {
    await Array.fromAsync(runTurn({ profile, input: { text } }, provider));
  } catch (error) {
    if (error instanceof TheoremError) return { sent, error };
    throw error;
  }
  return { sent };
}

define('limit_ten', { text: true, maxTextChars: 10 });
define('limit_none', { text: true });
define('limit_raw', { text: true, maxTextChars: 20 }, TAKE_OUT_INBOUND);

Deno.test('a message over inputs.maxTextChars is refused before the model, with no files', async () => {
  const { sent, error } = await turn('limit_ten', 'x'.repeat(11));
  assertEquals(sent, null);
  assertEquals(error?.kind, 'input');
  assertEquals(error?.copy, [{ key: 'text.too_long', params: { maxTextChars: 10 } }]);
});

Deno.test('a message of exactly maxTextChars is taken', async () => {
  const { sent, error } = await turn('limit_ten', 'x'.repeat(10));
  assertEquals(error, undefined);
  assertEquals(sent?.includes('x'.repeat(10)), true);
});

Deno.test('without maxTextChars a long message is taken', async () => {
  const { error } = await turn('limit_none', 'x'.repeat(200_000));
  assertEquals(error, undefined);
});

Deno.test('the count is of the raw text, not of what the detect reader sends on', async () => {
  const { sent, error } = await turn('limit_raw', 'write to jane.doe@example.com today please');
  assertEquals(sent, null);
  assertEquals(error?.copy, [{ key: 'text.too_long', params: { maxTextChars: 20 } }]);
});

Deno.test('registration refuses a limit that is not a positive whole number, or that text:false contradicts', () => {
  const refuse = (inputs: ProfileInputsSpec) =>
    assertThrows(() => define('limit_bad', inputs), TheoremError, 'maxTextChars');
  refuse({ text: true, maxTextChars: 0 });
  refuse({ text: true, maxTextChars: -3 });
  refuse({ text: true, maxTextChars: 1.5 });
  refuse({ text: false, maxTextChars: 10 });
});

Deno.test('only text and image profiles take maxTextChars', () => {
  assertEquals(profileTypesForField('inputs.maxTextChars'), ['text', 'image']);
});
