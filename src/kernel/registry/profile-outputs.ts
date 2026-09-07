import type { Profile, ProfileOutputsSpec } from '../types.ts';

/** Turn-based `outputs` pins — absent on `type: 'live'`. */
function profileTurnOutputs(profile: Profile): ProfileOutputsSpec | undefined {
  if (profile.type === 'live') {
    return undefined;
  }
  return profile.outputs;
}

export { profileTurnOutputs };
