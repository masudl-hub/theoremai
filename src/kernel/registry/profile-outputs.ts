import type { Profile, ProfileOutputsSpec } from '../types.ts';

function profileTurnOutputs(profile: Profile): ProfileOutputsSpec | undefined {
  if (profile.type === 'live' || profile.type === 'host' || profile.type === 'decision') {
    return undefined;
  }
  return profile.outputs;
}

export { profileTurnOutputs };
