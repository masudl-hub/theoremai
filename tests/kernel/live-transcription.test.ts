import '../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import { registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import type { ProfileLiveSpec } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const liveBase = {
  type: 'live' as const,
  identity: { handle: 'live', system: 'hi' },
  ...geminiModels('gemini31FlashLive'),
  tools: { allow: [] as string[] },
};

/** `guarded` false sets every detector that reads `live_reply` by default to `ignore`. */
function resolvedLive(id: string, live: ProfileLiveSpec, guarded?: boolean) {
  const unread = {
    canary_leak: 'ignore',
    prompt_leak: 'ignore',
    marker_leak: 'ignore',
    ungiven_images: 'ignore',
  } as const;
  registerProfile({
    ...liveBase,
    id,
    live,
    ...(guarded === false ? { guardrails: { detect: unread } } : {}),
  });
  return resolveTurn({ profile: id, input: { text: '' } }).generation.live;
}

Deno.test('resolveTurn transcribes a guarded Live profile its own speech', () => {
  assertEquals(resolvedLive('live_guarded_quiet', {})?.transcription, { output: true });
  assertEquals(
    resolvedLive('live_guarded_input', { transcription: { input: true, output: false } })
      ?.transcription,
    { input: true, output: true },
  );
});

Deno.test('resolveTurn leaves transcription as set on an unguarded Live profile', () => {
  assertEquals(resolvedLive('live_unguarded', { voice: 'Puck' }, false), { voice: 'Puck' });
});
