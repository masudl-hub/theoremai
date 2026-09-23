import type { Profile, ProfileOutputsSpec } from '../types.ts';

/** Turn-based `outputs` pins — absent on `type: 'live'` and `type: 'host'`. */
function profileTurnOutputs(profile: Profile): ProfileOutputsSpec | undefined {
  if (profile.type === 'live' || profile.type === 'host' || profile.type === 'decision') {
    return undefined;
  }
  return profile.outputs;
}

export { profileTurnOutputs };
