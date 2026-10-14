/**
 * Stops with the install line when a package the studio runs on is missing. The studio is opt-in:
 * nothing installs it with the kernel, so its commands check for it and never install it themselves.
 * The packages resolve from here as the studio's own code finds them: beside it in the repo, or
 * in the project's install when the studio is installed from the registry.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_PAGE } from './page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Whether this is the installed package, with its page built. The repo's page is built as it is served. */
export const builtPage = existsSync(path.join(here, BUILT_PAGE, 'index.html'));
/** What the project's server runs on, and in the repo what Vite builds the page from. */
const NEEDED = [
	'zod',
	'@theoremjs/agents',
	'@theoremjs/react',
	...(builtPage ? [] : ['react', 'react-dom', '@astryxdesign/core', 'vite']),
];

/** Whether `name` is installed where Node would look for it from here; its exports need not list its manifest. */
const installed = (name) =>
	(require.resolve.paths(name) ?? []).some((dir) => existsSync(path.join(dir, name, 'package.json')));
const missing = NEEDED.filter((name) => !installed(name));
if (missing.length) {
	const line = here.split(path.sep).includes('node_modules')
		? `npm install ${missing.join(' ')}`
		: `npm install --prefix ${here}`;
	console.error(`The studio is missing ${missing.join(', ')}. Install it once, then run this again:\n\n  ${line}\n`);
	process.exit(1);
}
