import '../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { wrapUserData } from '../../src/guardrails/canary.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
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

Deno.test('resolveTurn sends the continue instruction as the user message, not system', () => {
  registerTestProfile('STATIC_PROFILE_SYSTEM');
  const { generation } = resolveTurn({
    profile: PROFILE_ID,
    input: { history: [{ role: 'assistant', content: 'partial' }] },
    continueFrom: { stop: { kind: 'length' } },
  });
  assertEquals(generation.resolvedSystem, 'STATIC_PROFILE_SYSTEM');
  assertEquals(generation.input, [{ type: 'text', text: wrapUserData(CONTINUE_INSTRUCTION) }]);
});

Deno.test('resolveTurn rejects input.text on a text continueFrom turn', () => {
  registerTestProfile();
  assertThrows(
    () =>
      resolveTurn({
        profile: PROFILE_ID,
        input: { text: 'hi' },
        continueFrom: { stop: { kind: 'length' } },
      }),
    TheoremError,
  );
});
