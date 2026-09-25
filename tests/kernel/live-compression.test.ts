import { assertEquals, assertThrows } from '@std/assert';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { LiveContextCompressionSpec } from '../../src/kernel/types.ts';

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

function liveWith(id: string, contextCompression: LiveContextCompressionSpec) {
  return defineProfile({ ...liveBase, id, live: { contextCompression } });
}

Deno.test('defineProfile keeps a live sliding window with its trigger and target', () => {
  const spec = { triggerTokens: 100_000, slidingWindow: { targetTokens: 40_000 } };
  const profile = liveWith('live_window', spec);
  assertEquals(profile.type === 'live' && profile.live.contextCompression, spec);
});

Deno.test('defineProfile takes a sliding window that leaves both numbers to the provider', () => {
  const profile = liveWith('live_window_default', { slidingWindow: {} });
  assertEquals(profile.type === 'live' && profile.live.contextCompression, { slidingWindow: {} });
});

Deno.test('defineProfile rejects compression numbers that are not whole and above 0', () => {
  assertThrows(
    () => liveWith('live_trigger_zero', { triggerTokens: 0, slidingWindow: {} }),
    Error,
    'triggerTokens must be a whole number above 0',
  );
  assertThrows(
    () => liveWith('live_target_fraction', { slidingWindow: { targetTokens: 1.5 } }),
    Error,
    'slidingWindow.targetTokens must be a whole number above 0',
  );
});

Deno.test('defineProfile rejects a sliding-window target at or above the trigger', () => {
  assertThrows(
    () =>
      liveWith('live_target_high', {
        triggerTokens: 50_000,
        slidingWindow: { targetTokens: 50_000 },
      }),
    Error,
    'slidingWindow.targetTokens must be below triggerTokens',
  );
});
