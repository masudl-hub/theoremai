import { assertEquals, assertThrows } from '@std/assert';
import {
  assertLiveIngress,
  assertLiveIngressConfigured,
  hasAnyLiveIngress,
  liveIngressChannelDefault,
  liveIngressEnabled,
  liveIngressEnabledFromSpec,
} from '../../src/kernel/engine/live-ingress.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { LiveProfile } from '../../src/kernel/types.ts';

const liveBase = {
  type: 'live' as const,
  identity: { handle: 'live', system: 'hi' },
  model: {
    protocol: 'geminiLive' as const,
    provider: 'google' as const,
    allow: ['gemini31FlashLive'],
    config: {
      gemini31FlashLive: {
        apiId: 'gemini-3.1-flash-live-preview',
        thinking: { on: 'none' as const, off: 'none' as const },
        thinkingLevels: ['none' as const],
        summaries: { on: 'none' as const, off: 'none' as const },
        builtInTools: [],
      },
    },
  },
  tools: { allow: [] as string[] },
};

const liveProfile = defineProfile({
  ...liveBase,
  id: 'live_ingress',
  live: {
    ingress: { audio: true, video: false, text: true },
  },
});

Deno.test('liveIngressChannelDefault enables audio and text, disables video', () => {
  assertEquals(liveIngressChannelDefault('audio'), true);
  assertEquals(liveIngressChannelDefault('video'), false);
  assertEquals(liveIngressChannelDefault('text'), true);
});

Deno.test('liveIngressEnabledFromSpec uses channel defaults when omitted', () => {
  assertEquals(liveIngressEnabledFromSpec(undefined, 'audio'), true);
  assertEquals(liveIngressEnabledFromSpec(undefined, 'video'), false);
  assertEquals(liveIngressEnabledFromSpec(undefined, 'text'), true);
});

Deno.test('liveIngressEnabled respects live.ingress toggles', () => {
  assertEquals(liveIngressEnabled(liveProfile, 'audio'), true);
  assertEquals(liveIngressEnabled(liveProfile, 'video'), false);
  assertEquals(liveIngressEnabled(liveProfile, 'text'), true);
});

Deno.test('hasAnyLiveIngress rejects all-disabled ingress', () => {
  const blocked: LiveProfile = {
    type: 'live',
    id: 'live_blocked',
    identity: { handle: 'live', system: 'hi' },
    model: liveBase.model,
    live: { ingress: { audio: false, video: false, text: false } },
    tools: { allow: [] },
  };
  assertEquals(hasAnyLiveIngress(blocked), false);
  assertThrows(
    () => assertLiveIngressConfigured(blocked),
    Error,
    'at least one live.ingress channel',
  );
});

Deno.test('defineProfile rejects live profiles with every ingress channel disabled', () => {
  assertThrows(
    () =>
      defineProfile({
        ...liveBase,
        id: 'live_all_off',
        live: { ingress: { audio: false, video: false, text: false } },
      }),
    Error,
    'at least one live.ingress channel',
  );
});

Deno.test('assertLiveIngress throws when channel is disabled', () => {
  assertThrows(
    () => assertLiveIngress(liveProfile, 'video'),
    Error,
    'live.ingress.video is disabled',
  );
});
