/**
 * Stops with the install line when the studio's own packages are missing. The studio is opt-in:
 * nothing installs it with the kernel, so its commands check for it and never install it themselves.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

if (!existsSync(path.join(here, 'node_modules/react'))) {
	console.error(`The studio is not installed. Install it once, then run this again:\n\n  npm install --prefix ${here}\n`);
	process.exit(1);
}
