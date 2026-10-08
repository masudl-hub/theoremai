import type { ProviderCheckpoint } from '../../mod.ts';
export const checkpointFixture: ProviderCheckpoint = {
  providerId: 'company',
  adapterId: 'external',
  version: 1,
  apiId: 'model',
  compatibilityKey: 'deployment',
  coveredHistoryLength: 0,
  coveredHistoryHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  data: { liveHandle: 'handle-1' },
};
export function googleLiveCheckpoint(apiId: string, liveHandle: string): ProviderCheckpoint {
  return {
    ...checkpointFixture,
    providerId: 'google',
    adapterId: 'google',
    apiId,
    compatibilityKey: JSON.stringify([{}, apiId, {}]),
    data: { liveHandle },
  };
}
