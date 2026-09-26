import type { ProfileDefinition } from '../mod.ts';
import type { ToolRegistration } from './registrations.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';

/** The first message on a playground live call: the draft the relay runs, on a scope of its own. */
export type PlaygroundLiveDraftMessage = {
  type: 'draft';
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
};

/**
 * A live call that carries its draft, so no other call can reach or replace it.
 * The react client's `LiveConnection` accepts it as is.
 */
export function playgroundLiveConnection(payload: PlaygroundRunPayload): {
  openMessage: PlaygroundLiveDraftMessage;
} {
  const openMessage: PlaygroundLiveDraftMessage = {
    type: 'draft',
    profile: payload.profile,
    customTools: payload.customTools,
  };
  return { openMessage };
}
