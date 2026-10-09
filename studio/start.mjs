/**
 * Opens the studio on a project, with one command:
 *
 *   node studio/start.mjs <setup-module>
 *
 * It starts the project's local server (`server/serve.ts`, under Deno, with the project's own
 * permissions) and the studio's page, and stops both together. Only this machine reaches either.
 * The studio is opt-in, so this checks for its install and never installs it.
 */
import './installed.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = 4984;
const PAGE = `http://127.0.0.1:${PAGE_PORT}`;

const [setup] = process.argv.slice(2);
if (!setup || setup.startsWith('--')) {
	console.error('usage: node studio/start.mjs <setup-module>');
	process.exit(2);
}

// The setup module is named from where the command was run, which is also the project's name.
const from = process.env.INIT_CWD ?? process.cwd();
const server = spawn(
	'deno',
	[
		'run',
		'--config',
		path.join(here, '../deno.json'),
		'-A',
		path.join(here, 'server/serve.ts'),
		path.resolve(from, setup),
		'--page',
		`${PAGE},http://localhost:${PAGE_PORT}`,
	],
	{ cwd: from, stdio: ['ignore', 'ignore', 'inherit'] },
);
const page = spawn(
	process.execPath,
	[path.join(here, 'node_modules/vite/bin/vite.js'), '--config', path.join(here, 'app/vite.config.ts')],
	{ cwd: here, stdio: ['ignore', 'ignore', 'inherit'] },
);

console.log(`theorem studio: ${PAGE}/studio/`);

let stopping = false;
/** Stops both when either ends or the command is interrupted. */
function stop(code) {
	if (stopping) return;
	stopping = true;
	server.kill();
	page.kill();
	process.exitCode = code;
}
server.on('exit', (code) => stop(code ?? 1));
page.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
