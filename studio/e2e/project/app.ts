import type { TurnWiring } from '@theoremjs/agents';
import {
  geminiProvider,
  openRouterProvider,
  registerProfile,
  registerProvider,
} from '@theoremjs/agents';
import { desk } from './agents/desk.ts';
import * as team from './agents/team.ts';
import { registerTools } from './tools.ts';

const FAKE = Deno.env.get('FAKE_MODEL_URL');
if (!FAKE) throw new Error('FAKE_MODEL_URL is not set: this project runs on no real model.');

const fake: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return fetch(`${FAKE}${url.pathname}`, init);
};

export const theorem: TurnWiring = {
  register() {
    registerProvider(openRouterProvider, { id: 'router', keySlot: 'router_key', connection: {} });
    registerProvider(geminiProvider, {
      id: 'google',
      keySlot: 'google_key',
      connection: { host: FAKE },
    });
    registerTools();
    registerProfile(desk);
    registerProfile(team.concierge);
    registerProfile(team.gatekeeper);
    registerProfile(team.triage);
    registerProfile(team.index);
    registerProfile(team.picture);
    registerProfile(team.reader);
    registerProfile(team.line);
  },
  provider: {
    vault: { router_key: 'fixture-placeholder', google_key: 'fixture-placeholder' },
    fetch: fake,
  },
};
