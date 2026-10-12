/**
 * Opens the studio on a project, with one command:
 *
 *   node studio/start.mjs [setup] [--editor <command>] [--deno-config <file>] [--no-watch]
 *
 * `setup` is a setup's file or its name. A setup is a file named `studio.setup.ts`, named for its
 * folder, or `<name>.studio.setup.ts`. With no `setup` the project's one setup opens, and when the
 * project has several the command asks which. A project gives this a short name of its own:
 * `"studio": "node <path to>/studio/start.mjs"` in its scripts makes it `npm run studio`.
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
 * A project already open in a studio is not opened twice: the command says where it is. A second
 * project opens beside the first, on the next free pair of ports.
 * The studio is opt-in, so this checks for its install and never installs it.
 */
import './installed.mjs';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldPairs, pageAddress, placeFor, serverAddress } from './ports.mjs';
import { chooseSetup, findSetups, setupLines, setupsNamed } from './setups.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = 'usage: node studio/start.mjs [setup] [--editor <command>] [--deno-config <file>] [--no-watch]';
/** The value after each flag that takes one. A flag with none, a second setup, or anything else, is a mistake. */
const VALUED = ['--editor', '--deno-config'];
const given = {};
let wanted;
let noWatch = false;
let mistaken = false;
const args = process.argv.slice(2);
for (let at = 0; at < args.length; at += 1) {
	const arg = args[at];
	if (arg === '--no-watch') noWatch = true;
	else if (VALUED.includes(arg)) {
		const value = args[at + 1];
		if (!value || value.startsWith('--')) mistaken = true;
		else given[arg] = value;
		at += 1;
	} else if (arg.startsWith('--') || wanted !== undefined) mistaken = true;
	else wanted = arg;
}
if (mistaken) {
	console.error(USAGE);
	process.exit(2);
}
const editor = given['--editor'];

// The setup module is named from where the command was run, which is also the project's name.
const from = process.env.INIT_CWD ?? process.cwd();
const setup = await setupToOpen();

/** Says why no setup opens, and stops. */
function refuse(message) {
	console.error(`${message}\n\n${USAGE}`);
	process.exit(2);
}

/** The setup this run opens: the file named, else the one found, else the one the builder picks. */
async function setupToOpen() {
	if (wanted !== undefined && existsSync(path.resolve(from, wanted))) return wanted;
	const found = findSetups(from);
	const setups = wanted === undefined ? found : setupsNamed(found, wanted);
	if (setups.length === 1) return setups[0].file;
	if (found.length === 0) {
		refuse(`No setup in ${from}. A setup is a file named studio.setup.ts, or <name>.studio.setup.ts.`);
	}
	if (setups.length === 0) {
		refuse(`No setup is named ${wanted}. This project has:\n\n${setupLines(found).join('\n')}`);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		refuse(`This project has more than one setup. Name the one to open:\n\n${setupLines(setups).join('\n')}`);
	}
	const chosen = await chooseSetup(setups, process.stdin, process.stdout);
	if (!chosen) process.exit(130);
	return chosen.file;
}
const place = placeFor(realpathSync(path.resolve(from, setup)), await heldPairs());
if (!place) refuse('Too many studios are open on this machine. Stop one, then run this again.');
const PAGE = pageAddress(place.pair);
if (place.running) {
	console.log(`theorem studio: already open on ${setup}: ${PAGE}/studio/`);
	process.exit(0);
}
if (setup !== wanted) console.log(`theorem studio: opening ${setup}`);
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
		'--port',
		String(place.pair.server),
		'--page',
		`${PAGE},http://localhost:${String(place.pair.page)}`,
		'--deno-config',
		projectConfig,
		...(editor ? ['--editor', editor] : []),
		...(noWatch ? ['--no-watch'] : []),
	],
	{ cwd: from, stdio: ['ignore', 'ignore', 'inherit'] },
);
const page = spawn(
	process.execPath,
	[
		path.join(here, 'node_modules/vite/bin/vite.js'),
		'--config',
		path.join(here, 'app/vite.config.ts'),
		'--port',
		String(place.pair.page),
	],
	{
		cwd: here,
		stdio: ['ignore', 'ignore', 'inherit'],
		env: { ...process.env, THEOREM_STUDIO_PROJECT: `${serverAddress(place.pair)}/api/studio` },
	},
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
