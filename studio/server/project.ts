/**
 * One load of the project: its setup module run, and its profiles and tools
 * served on a port only the studio's server calls. `serve.ts` starts this, and
 * starts it again after a Save, because a module that is loaded is not read
 * from disk a second time.
 *
 *   deno run -A studio/server/project.ts <setup-module> --port <port> --page <origins> [--edits]
 *
 * With `--edits` it reads the builder's unsaved edits from its input and lays them over what the
 * setup registered, before it serves: the load that answers as the project would after a Save.
 *
 * @module
 */

import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultKernelScope, type ProviderHostOptions } from '../../mod.ts';
import { type ProjectEdits, registerEdits } from './edits.ts';
import { createStudioHandler } from './handler.ts';

type SetupModule = {
  default?: () => unknown | Promise<unknown>;
  host?: (request: Request) => unknown;
  provider?: ProviderHostOptions;
};

/** The line this prints once it listens. `serve.ts` waits for it. */
export const PROJECT_READY = 'theorem-studio-project-ready';

if (import.meta.main) {
  const [setupPath = '', ...flags] = Deno.args;
  const flag = (name: string) => flags[flags.indexOf(`--${name}`) + 1] ?? '';
  const port = Number(flag('port'));
  const setup: SetupModule = await import(pathToFileURL(resolve(setupPath)).href);
  await setup.default?.();
  if (flags.includes('--edits')) {
    const edits: ProjectEdits = await new Response(Deno.stdin.readable).json();
    await registerEdits(defaultKernelScope, edits);
  }

  const handler = createStudioHandler({
    project: basename(Deno.cwd()),
    pageOrigins: flag('page').split(','),
    listenHost: `127.0.0.1:${port}`,
    ...(setup.host ? { host: setup.host } : {}),
    ...(setup.provider ? { provider: setup.provider } : {}),
  });
  Deno.serve({ hostname: '127.0.0.1', port, onListen: () => console.log(PROJECT_READY) }, handler);
}
