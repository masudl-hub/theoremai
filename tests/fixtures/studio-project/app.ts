import { registerProfile, registerTool } from '@theoremjs/agents';
import type { TurnWiring } from '@theoremjs/agents';
import { desk } from './agents/desk.ts';
import * as team from './agents/team.ts';
import * as P from './providers/index.ts';
import { registerOwn } from './providers/own.ts';
import { registerKit } from './tools/kit.ts';
import { wipe } from './tools/danger.ts';
import { scripted } from './model.ts';

export const theorem: TurnWiring = {
  register() {
    registerKit();
    registerTool(wipe);
    P.registerHouse();
    P.registerRouter();
    P.registerPair();
    P.registerSpaced();
    P.registerMade();
    P.registerOddProvider();
    registerOwn();
    registerProfile(desk);
    for (const profile of [team.concierge, team.gatekeeper, team.triage]) registerProfile(profile);
  },
  /** The keys the providers read, and the model they reach: a script, so nothing leaves the machine. */
  provider: {
    vault: { house_key: 'house-test-key', pair_key: 'pair-test-key', odd_key: 'odd-test-key', spaced_key: 'spaced-test-key' },
    fetch: scripted,
  },
};
