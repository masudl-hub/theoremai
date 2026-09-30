import '../fixtures/test-host.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { registerProfile, runSession, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider } from '../../src/kernel/types.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

const NOTE = lexiconDefault('user_data.note');

async function systemFor(profile: string, text = 'hi'): Promise<string | undefined> {
  let system: string | undefined;
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      system = req.system;
      yield { type: 'text', text: 'ok' };
    },
  };
  await Array.fromAsync(runTurn({ profile, input: { text } }, provider));
  return system;
}

Deno.test('text and image turns tell the model what the user_data tags mean', async () => {
  for (const profile of ['chat', 'image']) {
    const system = await systemFor(profile);
    assertEquals([profile, system?.endsWith(`\n\n${NOTE}`)], [profile, true]);
  }
});

Deno.test('the note is bound when the canary is off and there is no system prompt', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'user_data_note_bare',
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      identity: { handle: 'bare' },
      guardrails: { canary: false },
    }),
  );
  assertEquals(await systemFor('user_data_note_bare'), NOTE);
});

Deno.test('speech turns get no system prompt, so no note', async () => {
  assertEquals(await systemFor('speech', 'Say hello.'), '');
});

Deno.test('an empty user_data.note override leaves the note out', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'user_data_note_off',
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      identity: { handle: 'off', system: 'sys' },
      guardrails: { canary: false },
      lexicon: { 'user_data.note': '' },
    }),
  );
  assertEquals(await systemFor('user_data_note_off'), 'sys');
});

Deno.test('a live session binds the note into its setup', async () => {
  const profile = defineProfile({
    type: 'live',
    id: 'user_data_note_live',
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'slotA' } },
    live: { voice: 'Aoede' },
    tools: { allow: [] },
  });
  registerProfile(profile);
  const mock = new MockLiveWebSocket();
  mock.readyState = 1;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: {
        vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
      },
      openWebSocket: () => Promise.resolve(mock as unknown as WebSocket),
    },
  );
  const setup = JSON.parse(mock.sent.find((frame) => frame.includes('"setup"')) ?? '{}');
  assertEquals(setup.setup.systemInstruction.parts[0].text.endsWith(`\n\n${NOTE}`), true);
  mock.close();
  await session.close();
});
