/**
 * Starts the studio's local server for one project.
 *
 *   deno run -A studio/server/serve.ts <setup-module> [--port 4983] [--page http://localhost:5174]
 *
 * The setup module is the project's: its default export registers the project's
 * tools, profiles and providers; an optional `host` export gives tool handlers
 * their application context (the test user), and an optional `provider` export
 * says where the providers find their keys. Only this machine can reach the server.
 *
 * @module
 */

import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderHostOptions } from '../../mod.ts';
import { createStudioHandler } from './handler.ts';

type SetupModule = {
  default?: () => unknown | Promise<unknown>;
  host?: (request: Request) => unknown;
  provider?: ProviderHostOptions;
};

function flag(name: string, fallback: string): string {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? (Deno.args[at + 1] ?? fallback) : fallback;
}

const setupPath = Deno.args.find((arg, i) => !arg.startsWith('--') && !Deno.args[i - 1]?.startsWith('--'));
if (!setupPath) {
  console.error('usage: studio/server/serve.ts <setup-module> [--port 4983] [--page http://localhost:5174]');
  Deno.exit(2);
}

const port = Number(flag('port', '4983'));
/** The site's dev server, under either name a browser gives this machine. */
const pageOrigins = flag('page', 'http://localhost:5174,http://127.0.0.1:5174').split(',');
const setup: SetupModule = await import(pathToFileURL(resolve(setupPath)).href);
await setup.default?.();

const handler = createStudioHandler({
  project: basename(Deno.cwd()),
  pageOrigins,
  listenHost: `127.0.0.1:${port}`,
  ...(setup.host ? { host: setup.host } : {}),
  ...(setup.provider ? { provider: setup.provider } : {}),
});

Deno.serve({ hostname: '127.0.0.1', port }, handler);
console.log(`Theorem Studio: open ${pageOrigins[0]}/studio (server on http://127.0.0.1:${port})`);
