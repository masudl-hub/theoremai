import '../fixtures/test-host.ts';
import { registerProfile, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals, assertRejects, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnInput } from '../../src/kernel/types.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

registerProfile(
  defineProfile({
    type: 'text',
    id: 'slot_prompt',
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true, slots: { language: ['en', 'fr'] } },
    identity: { handle: 'slots', system: 'Reply in {language}. Keep {braces} as written.' },
  }),
);

/** The system text the model was sent for one turn. */
async function systemFor(input: TurnInput): Promise<string> {
  let system = '';
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      system = req.system ?? '';
      yield { type: 'text', text: 'ok' };
    },
  };
  await Array.fromAsync(runTurn({ profile: 'slot_prompt', input }, provider));
  return system;
}

Deno.test('a {slot} in identity.system becomes the value the turn chose', async () => {
  const system = await systemFor({ text: 'hi', slots: { language: 'fr' } });
  assertEquals(system.startsWith('Reply in fr. Keep {braces} as written.'), true);
});

Deno.test('a prompt that uses a slot the turn left unfilled is refused', async () => {
  await assertRejects(
    () => systemFor({ text: 'hi' }),
    Error,
    "identity.system uses slot 'language', and the request chose no value for it",
  );
});

Deno.test('a live profile takes slots and context, and no other inputs', () => {
  const live = {
    type: 'live' as const,
    id: 'slot_live',
    identity: { handle: 'live', system: 'Reply in {language}.' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'main' } },
    live: { voice: 'Aoede' },
    tools: { allow: [] },
  };
  const profile = defineProfile({
    ...live,
    inputs: { slots: { language: ['en'] }, context: { from: ['client'], maxChars: 100 } },
  });
  assertEquals(profile.type === 'live' && profile.inputs?.context?.maxChars, 100);
  assertThrows(
    // @ts-expect-error a live profile's inputs hold slots and context only
    () => defineProfile({ ...live, inputs: { text: true } }),
    Error,
    'inputs.text',
  );
});
