import { assertEquals } from '@std/assert';
import { createKernelScope, defineProfile, labelDefault } from '../../mod.ts';
import { geminiInteractions, geminiProvider } from '../../src/providers/mod.ts';

const UPSTREAM = 'connection reset by 10.0.0.7:443';

Deno.test('a call that fails once sent shows the profile wording, and the upstream text stays internal', async () => {
  const scope = createKernelScope();
  const provider = scope.providers.register(geminiProvider, { keySlot: 'main' });
  scope.profiles.register(
    defineProfile({
      id: 'worded',
      type: 'text',
      identity: { handle: 'Worded' },
      models: { main: provider.model(geminiInteractions, 'gemini-3.5-flash-lite') },
      inputs: { text: true },
      tools: { allow: [] },
      maxSteps: 1,
    }),
  );
  const send: typeof fetch = () => Promise.reject(new Error(UPSTREAM));
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: 'worded', input: { text: 'hi' } },
      { fetch: send, vault: { main: 'fixture-key' }, wait: () => Promise.resolve() },
    ),
  );
  const failed = events.find((event) => event.type === 'error');
  assertEquals(failed?.type === 'error' && failed.errorKind, 'network');
  assertEquals(failed?.type === 'error' && failed.error, labelDefault('error.network'));
  assertEquals(
    JSON.stringify(events.filter((event) => event.type !== 'error')).includes(UPSTREAM),
    false,
  );
});
