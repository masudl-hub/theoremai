import { postJson } from '../react/src/client/transport.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';

/** Register the draft live profile on the playground host; resolves its id for the relay. */
export async function registerPlaygroundLiveProfile(payload: PlaygroundRunPayload): Promise<string> {
  const data = await postJson<{ profileId: string }>(
    '/api/playground/live/register',
    { profile: payload.profile, customTools: payload.customTools },
  );
  return data.profileId;
}
