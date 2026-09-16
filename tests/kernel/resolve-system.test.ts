import '../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import {
  clearProfiles,
  defineProfile,
  registerProfile,
} from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { CONTINUE_INSTRUCTION } from '../../src/kernel/stop.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE_ID = 'resolve-system.test';

function registerTestProfile(system?: string): void {
  clearProfiles();
  registerProfile(
    defineProfile({
      id: PROFILE_ID,
      type: 'text',
      identity: { handle: 'Tester', ...(system ? { system } : {}) },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
}

Deno.test('resolveTurn snapshots profile + turn system synchronously', () => {
  registerTestProfile('STATIC_PROFILE_SYSTEM');
  const { generation } = resolveTurn({
    profile: PROFILE_ID,
    system: 'HOST_TURN_SYSTEM',
    input: { text: 'hi' },
  });
  assertEquals(generation.resolvedSystem, 'STATIC_PROFILE_SYSTEM\n\nHOST_TURN_SYSTEM');
});

Deno.test('resolveTurn turn-only system when profile system empty', () => {
  registerTestProfile();
  const { generation } = resolveTurn({
    profile: PROFILE_ID,
    system: 'HOST_ONLY',
    input: { text: 'hi' },
  });
  assertEquals(generation.resolvedSystem, 'HOST_ONLY');
});

Deno.test('resolveTurn appends the continue instruction for continueFrom turns', () => {
  registerTestProfile('STATIC_PROFILE_SYSTEM');
  const { generation } = resolveTurn({
    profile: PROFILE_ID,
    input: { text: 'hi' },
    continueFrom: { stop: { kind: 'length' } },
  });
  assertEquals(generation.resolvedSystem, `STATIC_PROFILE_SYSTEM\n\n${CONTINUE_INSTRUCTION}`);
});
