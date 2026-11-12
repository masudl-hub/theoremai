import type { ToolBackgroundService, TurnWiring } from '@theoremjs/agents';
import {
  createMemoryToolExecution,
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

// why: The project keeps its own record of late tool calls, as an app with a job store does.
const execution = createMemoryToolExecution();
const background: ToolBackgroundService = { detached() {}, event() {} };

const fake: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return fetch(`${FAKE}${url.pathname}`, init);
};

const quiet = (host: unknown) =>
  typeof host === 'object' && host !== null && 'person' in host && host.person === 'north-ana';

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
    registerProfile(team.frontCounter);
    registerProfile(team.backCounter);
    registerProfile(team.triage);
    registerProfile(team.index);
    registerProfile(team.picture);
    registerProfile(team.reader);
    registerProfile(team.line);
    registerProfile(team.scout);
  },
  prepare: (turn) => ({ ...turn, execution, background }),
  // why: The app decides who hears of a late result. Ana of north has quiet hours: no reply she
  // did not ask for tells her one, and her next message reads it.
  lateResultsDecider: {
    policy: (items, { host, opening }) => ({
      tell: opening !== 'message' && quiet(host) ? [] : items.map((item) => item.id),
    }),
  },
  provider: {
    vault: { router_key: 'fixture-placeholder', google_key: 'fixture-placeholder' },
    fetch: fake,
  },
};
