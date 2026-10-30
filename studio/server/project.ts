/**
 * One load of the project: its setup module run, and its profiles and tools
 * served on a port only the studio's server calls. `serve.ts` starts this, and
 * starts it again after a Save, because a module that is loaded is not read
 * from disk a second time.
 *
 *   deno run -A studio/server/project.ts <setup-module> --port <port> --page <origins>
 *
 * It reads a `ProjectLoad` from its input: the key its chats are sealed with, and the builder's
 * unsaved edits when there are some. Edits are laid over what the setup registered, before it
 * serves: the load that answers as the project would after a Save.
 *
 * @module
 */

import { basename } from 'node:path';
import { defaultKernelScope } from '@theoremjs/agents';
import { loadSetup } from '@theoremjs/agents/cli';
import type { StudioActingAs, StudioPeople } from '../people.ts';
import { editedImages, editedQuestions, type ProjectEdits, registerEdits } from './edits.ts';
import { createStudioHandler, type ProjectImages, type ProjectQuestions } from './handler.ts';

type SetupModule = {
  /** The application's entry point, relative to the setup file. It exports `theorem`, a `TurnWiring`. */
  entry?: unknown;
  /** What the tools read as `ctx.host`, for the person the builder picked; `undefined` is no one. A promise is awaited first. */
  host?: (request: Request, actingAs: StudioActingAs | undefined) => unknown;
  /** The places and people a run may act as. Read before it is trusted: a setup is not always type-checked. */
  people?: StudioPeople;
  /** What each decision profile asks, by the profile's id. */
  questions?: ProjectQuestions;
  /** The pictures each decision profile sends, by the profile's id. */
  images?: ProjectImages;
};

/** What `serve.ts` hands each load on its input. The key never touches disk. */
export type ProjectLoad = { conversationKey: string; edits?: ProjectEdits };

/** The line this prints once it listens. `serve.ts` waits for it. */
export const PROJECT_READY = 'theorem-studio-project-ready';

if (import.meta.main) {
  const [setupPath = '', ...flags] = Deno.args;
  const flag = (name: string) => flags[flags.indexOf(`--${name}`) + 1] ?? '';
  const port = Number(flag('port'));
  const loaded = await loadSetup(setupPath);
  const setup = loaded.setup as SetupModule;
  const { theorem } = loaded;
  await theorem.register?.();
  const load: ProjectLoad = await new Response(Deno.stdin.readable).json();
  let { questions, images } = setup;
  if (load.edits) {
    await registerEdits(defaultKernelScope, load.edits);
    questions = editedQuestions(load.edits, questions);
    images = editedImages(load.edits, images);
  }

  const handler = createStudioHandler({
    project: basename(Deno.cwd()),
    pageOrigins: flag('page').split(','),
    listenHost: `127.0.0.1:${port}`,
    ...(setup.host ? { host: setup.host } : {}),
    ...(setup.people !== undefined ? { people: setup.people } : {}),
    ...(theorem.provider ? { provider: theorem.provider } : {}),
    ...(theorem.prepare ? { prepare: theorem.prepare } : {}),
    ...(questions ? { questions } : {}),
    ...(images ? { images } : {}),
    upgrade: (request) => Deno.upgradeWebSocket(request),
    conversationKey: load.conversationKey,
  });
  Deno.serve({ hostname: '127.0.0.1', port, onListen: () => console.log(PROJECT_READY) }, handler);
}
