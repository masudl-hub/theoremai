import '../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import { registerProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { ProfileLiveSpec } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const liveBase = {
  type: 'live' as const,
  identity: { handle: 'live', system: 'hi' },
  ...geminiModels('gemini31FlashLive'),
  tools: { allow: [] as string[] },
};

function resolvedLive(id: string, live: ProfileLiveSpec, canary?: boolean) {
  registerProfile({
    ...liveBase,
    id,
    live,
    ...(canary === undefined ? {} : { guardrails: { canary } }),
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
