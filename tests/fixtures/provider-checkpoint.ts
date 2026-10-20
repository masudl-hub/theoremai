import type { ProviderCheckpoint } from '../../mod.ts';
export const checkpointFixture: ProviderCheckpoint = {
  protocol: 'external',
  provider: 'company',
  version: 1,
  apiId: 'model',
  compatibilityKey: 'deployment',
  coveredHistoryLength: 0,
  coveredHistoryHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  data: { liveHandle: 'handle-1' },
};
/** A Gemini Live checkpoint for the fixture `gemini` registration, which has no connection set. */
export function geminiLiveCheckpoint(apiId: string, handle: string): ProviderCheckpoint {
  return {
    ...checkpointFixture,
    protocol: 'geminiLive',
    provider: 'gemini',
    apiId,
    keySlot: 'slot_a',
    compatibilityKey: JSON.stringify({ connection: {}, options: [] }),
    data: { liveHandle: handle },
  };
}
