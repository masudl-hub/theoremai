import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnInput, TurnModel } from '../../src/kernel/types.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

registerProfile(
  defineProfile({
    type: 'text',
    id: 'option_prompt',
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true, options: { language: { choices: [{ value: 'en' }, { value: 'fr' }] } } },
    identity: { handle: 'prompt', system: 'Reply in {language}. Keep {braces} as written.' },
  }),
);
/** The system text the model was sent for one turn. */
async function systemFor(input: TurnInput): Promise<string> {
  let system = '';
  const provider: TurnModel = {
    async *complete(req) {
      await Promise.resolve();
      system = req.system ?? '';
      yield { type: 'text', text: 'ok' };
    },
  };
  await Array.fromAsync(runTurn({ profile: 'option_prompt', input }, provider));
  return system;
}
Deno.test('an {option} in identity.system becomes the value the turn chose', async () => {
  const system = await systemFor({ text: 'hi', options: { language: 'fr' } });
  assertEquals(system.startsWith('Reply in fr. Keep {braces} as written.'), true);
});
Deno.test('a line that prints an option the turn left unset is not sent', async () => {
  const system = await systemFor({ text: 'hi' });
  assertEquals(system.includes('Reply in'), false);
});
Deno.test('a live profile takes options and context, and no other inputs', () => {
  const live = {
    type: 'live' as const,
    id: 'option_live',
    identity: { handle: 'live', system: 'Reply in {language}.' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, keySlot: 'main' } },
    live: { voice: 'Aoede' },
    tools: { allow: [] },
  };
  const profile = defineProfile({
    ...live,
    inputs: {
      options: { language: { choices: [{ value: 'en' }] } },
      context: { from: ['client'], maxChars: 100 },
    },
  });
  assertEquals(profile.type === 'live' && profile.inputs?.context?.maxChars, 100);
  assertThrows(
    // @ts-expect-error a live profile's inputs hold options and context only
    () => defineProfile({ ...live, inputs: { text: true } }),
    Error,
    'inputs.text',
  );
});

Deno.test('defineProfile keeps the label of an option and the descriptions of its choices', () => {
  const labeled = defineProfile({
    type: 'text',
    id: 'option_labeled',
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: {
      text: true,
      options: {
        focus: {
          label: 'Source Bias',
          choices: [
            { value: 'Any Source', description: 'No preferred kind.' },
            { value: 'Academic Research' },
          ],
        },
      },
    },
    identity: { handle: 'prompt', system: 'Focus: {focus}.' },
  });
  assertEquals(labeled.inputs?.options, {
    focus: {
      label: 'Source Bias',
      choices: [
        { value: 'Any Source', description: 'No preferred kind.' },
        { value: 'Academic Research' },
      ],
    },
  });
});
