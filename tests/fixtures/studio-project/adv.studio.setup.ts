import { registerProfile, registerProvider, registerTool } from '@theoremjs/agents';
import type { ProviderHostOptions } from '@theoremjs/agents';
import { desk } from './agents/desk.ts';
import * as team from './agents/team.ts';
import * as P from './providers/index.ts';
import { own } from './providers/own.ts';
import { registerKit } from './tools/kit.ts';
import { wipe } from './tools/danger.ts';
import { scripted } from './model.ts';

export default function setup(): void {
  registerKit();
  registerTool(wipe);
  registerProvider(P.house);
  registerProvider(P.router);
  registerProvider(P.left);
  registerProvider(P.right);
  registerProvider(P.spaced);
  registerProvider(P.madeA);
  registerProvider(P.madeB);
  registerProvider(P.oddProvider);
  registerProvider(own);
  registerProfile(desk);
  for (const profile of [team.concierge, team.gatekeeper, team.triage]) registerProfile(profile);
}

/** The keys the providers read, and the model they reach: a script, so nothing leaves the machine. */
export const provider: ProviderHostOptions = {
  vault: { house_key: 'house-test-key', pair_key: 'pair-test-key', odd_key: 'odd-test-key', spaced_key: 'spaced-test-key' },
  fetch: scripted,
};

export const questions = {
  triage: {
    next: {
      type: 'choice',
      instructions: 'Choose the safest next step.',
      criteria: { ask: 'Ask the person first.', act: 'Go ahead.' },
    },
  },
};
