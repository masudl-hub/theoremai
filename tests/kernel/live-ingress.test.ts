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
  models: {
    gemini31FlashLive: {
      protocol: 'geminiLive' as const,
      provider: 'google' as const,
      apiId: 'gemini-3.1-flash-live-preview',
      efforts: { normal: 'none' as const },
      summaries: false,
      builtInTools: [],
    },
  },
  tools: { allow: [] as string[] },
};

const liveProfile = defineProfile({
  ...liveBase,
  id: 'live_ingress',
  live: {
    ingress: { audio: true, video: true, text: false },
  },
});

Deno.test('liveIngressChannelDefault enables audio and video, disables text', () => {
  assertEquals(liveIngressChannelDefault('audio'), true);
  assertEquals(liveIngressChannelDefault('video'), true);
  assertEquals(liveIngressChannelDefault('text'), false);
});

Deno.test('liveIngressEnabledFromSpec uses channel defaults when omitted', () => {
  assertEquals(liveIngressEnabledFromSpec(undefined, 'audio'), true);
  assertEquals(liveIngressEnabledFromSpec(undefined, 'video'), true);
  assertEquals(liveIngressEnabledFromSpec(undefined, 'text'), false);
});

Deno.test('liveIngressEnabled respects live.ingress toggles', () => {
  assertEquals(liveIngressEnabled(liveProfile, 'audio'), true);
  assertEquals(liveIngressEnabled(liveProfile, 'video'), true);
  assertEquals(liveIngressEnabled(liveProfile, 'text'), false);
});

Deno.test('hasAnyLiveIngress rejects all-disabled ingress', () => {
  const blocked: LiveProfile = {
    type: 'live',
    id: 'live_blocked',
    identity: { handle: 'live', system: 'hi' },
    models: liveBase.models,
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
    () => assertLiveIngress(liveProfile, 'text'),
    Error,
    'live.ingress.text is disabled',
  );
});
