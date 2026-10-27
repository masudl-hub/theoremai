/**
 * `agents studio`: runs the studio the project installed, with the arguments it was given. The
 * studio is its own package, so this only finds its command; it never installs it.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What the builder runs when the project has no studio. */
export const STUDIO_MISSING =
  'The studio is not installed in this project. Install it: npm install -D @theoremjs/studio';

/**
 * The studio's command, from the nearest `node_modules/@theoremjs/studio` at or above `from`.
 * Undefined when the project installed none.
 */
export function installedStudio(from: string): string | undefined {
  for (let at = from; ; at = dirname(at)) {
    const folder = join(at, 'node_modules', '@theoremjs', 'studio');
    const manifest = join(folder, 'package.json');
    if (existsSync(manifest)) {
      const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: Record<string, string> })
        .bin?.['theorem-studio'];
      return bin ? join(folder, bin) : undefined;
    }
    if (dirname(at) === at) return undefined;
  }
}

/** Runs the installed studio's command with `args`, and answers with its exit code. */
export function studioCommand(args: readonly string[], from: string): Promise<number> {
  const command = installedStudio(from);
  if (!command) {
    console.error(STUDIO_MISSING);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const studio = spawn('node', [command, ...args], { cwd: from, stdio: 'inherit' });
    studio.on('error', (error) => {
      console.error(`agents studio: ${error.message}`);
      resolve(1);
    });
    studio.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1)));
  });
}
