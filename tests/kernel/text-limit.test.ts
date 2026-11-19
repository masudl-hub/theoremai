import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { profileTypesForField } from '../../src/kernel/profile-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ProfileInputsSpec, TurnModel } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

function define(id: string, inputs: ProfileInputsSpec): void {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs,
      identity: { handle: id, system: 'sys' },
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
registerProfile(
  defineProfile({
    type: 'image',
    id: 'limit_image',
    ...geminiModels('gemini31FlashLiteImage'),
    image: { aspectRatio: '1:1', resolution: '1K', mimeType: 'image/png', includeText: false },
    identity: { handle: 'limit_image' },
    inputs: { text: true, maxTextChars: 10 },
    tools: { allow: [] },
    outputs: { structured: null },
  }),
);
define('limit_none', { text: true });

Deno.test('a message over inputs.maxTextChars is refused before the model, with no files', async () => {
  const { sent, error } = await turn('limit_ten', 'x'.repeat(11));
  assertEquals(sent, null);
  assertEquals(error?.kind, 'input');
  assertEquals(error?.copy, [{ key: 'text.too_long', params: { maxTextChars: 10 } }]);
});

Deno.test('an image profile refuses a long prompt the same way', async () => {
  const { sent, error } = await turn('limit_image', 'x'.repeat(11));
  assertEquals(sent, null);
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

Deno.test('the public resolveTurn refuses a message over the limit, as a run does', () => {
  let refused: unknown;
  try {
    resolveTurn({ profile: 'limit_ten', input: { text: 'x'.repeat(11) } });
  } catch (error) {
    refused = error;
  }
  assertEquals(refused instanceof TheoremError, true);
  assertEquals(refused instanceof TheoremError && refused.kind, 'input');
  assertEquals(refused instanceof TheoremError && refused.copy, [
    { key: 'text.too_long', params: { maxTextChars: 10 } },
  ]);
  assertEquals(
    resolveTurn({ profile: 'limit_ten', input: { text: 'x'.repeat(10) } }) !== null,
    true,
  );
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
