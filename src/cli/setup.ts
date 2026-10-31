/**
 * A project's setup file, as the studio and `agents test` / `agents run` read it: the setup
 * module, and the `theorem` wiring its entry exports.
 *
 * @module
 */

import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NormalizedTurnRequest, TurnRequest, TurnWiring } from '../kernel/types.ts';

/** A loaded setup: the module as it is, and its entry's wiring. */
export interface LoadedSetup {
  setup: Record<string, unknown>;
  theorem: TurnWiring;
}

/**
 * Imports the setup at `setupPath`, then its `entry`, relative to the setup, and returns the
 * `theorem` that entry exports. A setup written before the entry existed fails, and says what
 * moved where. Registers nothing: call `theorem.register` for that.
 */
export async function loadSetup(setupPath: string): Promise<LoadedSetup> {
  const setup: Record<string, unknown> = await import(pathToFileURL(resolve(setupPath)).href);
  const moved = (['default', 'provider'] as const).filter((name) => setup[name] !== undefined);
  if (moved.length > 0) {
    throw new Error(
      `${setupPath} exports ${moved.map((name) => `\`${name}\``).join(' and ')}. The app's wiring moved to its entry: export \`theorem\` (a TurnWiring) from the entry, with registration in \`theorem.register\` and keys in \`theorem.provider\`, and export \`entry\` from the setup.`,
    );
  }
  if (typeof setup.entry !== 'string' || !setup.entry) {
    throw new Error(
      `${setupPath} names no entry. Export \`entry\`: the path of your app's entry point, relative to the setup file, which exports \`theorem\` (a TurnWiring).`,
    );
  }
  const entryPath = resolve(dirname(resolve(setupPath)), setup.entry);
  const entry: Record<string, unknown> = await import(pathToFileURL(entryPath).href);
  const theorem = entry.theorem;
  if (!theorem || typeof theorem !== 'object') {
    throw new Error(
      `${setup.entry} exports no \`theorem\`. Export the TurnWiring your app runs its turns with: \`export const theorem: TurnWiring = { register, provider, prepare }\`.`,
    );
  }
  return { setup, theorem: theorem as TurnWiring };
}

/** `req` through the application's `prepare`, on the profile the command named. */
export async function preparedRequest(
  prepare: TurnWiring['prepare'],
  req: TurnRequest,
): Promise<TurnRequest> {
  if (!prepare) return req;
  const turn: NormalizedTurnRequest = { ...req, input: req.input ?? {} };
  return { ...(await prepare(turn)), profile: req.profile };
}
