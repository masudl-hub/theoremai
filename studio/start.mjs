/**
 * Opens the studio on a project, with one command:
 *
 *   node studio/start.mjs <setup-module> [--editor <command>] [--deno-config <file>] [--no-watch]
 *
 * It starts the project's local server (`server/serve.ts`, under Deno, with the project's own
 * permissions) and the studio's page, and stops both together. Only this machine reaches either.
 * `--editor` names the editor the studio opens a line of the project's files in; without it the
 * studio uses `$VISUAL` or `$EDITOR` when that opens a window, and `code` otherwise. When that one
 * does not start, the machine's default editor opens the file.
 * The studio watches the files the setup reads and takes in what the builder's editor changes;
 * `--no-watch` turns that off, and the studio then reads them when the builder comes back to it.
 * The project loads with its own Deno config: the one `--deno-config` names, else the `deno.json`
 * or `deno.jsonc` in the folder the command ran in, else the studio's.
 * The studio is opt-in, so this checks for its install and never installs it.
 */
import './installed.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = 4984;
const PAGE = `http://127.0.0.1:${PAGE_PORT}`;

const [setup, ...rest] = process.argv.slice(2);
const noWatch = rest.includes('--no-watch');
const named = rest.filter((arg) => arg !== '--no-watch');
/** The value after each flag that takes one. A flag with none, or anything else, is a mistake. */
const VALUED = ['--editor', '--deno-config'];
const given = {};
let mistaken = !setup || setup.startsWith('--');
for (let at = 0; at < named.length; at += 2) {
	const value = named[at + 1];
	if (!VALUED.includes(named[at]) || !value || value.startsWith('--')) mistaken = true;
	else given[named[at]] = value;
}
if (mistaken) {
	console.error(
		'usage: node studio/start.mjs <setup-module> [--editor <command>] [--deno-config <file>] [--no-watch]',
	);
	process.exit(2);
}
const editor = given['--editor'];

// The setup module is named from where the command was run, which is also the project's name.
const from = process.env.INIT_CWD ?? process.cwd();
const ownConfig = ['deno.json', 'deno.jsonc'].map((name) => path.join(from, name)).find(existsSync);
const projectConfig = given['--deno-config']
	? path.resolve(from, given['--deno-config'])
	: (ownConfig ?? path.join(here, '../deno.json'));
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
		'--deno-config',
		projectConfig,
		...(editor ? ['--editor', editor] : []),
		...(noWatch ? ['--no-watch'] : []),
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
