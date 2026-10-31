#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Opens the studio on a project, with one command:
 *
 *   theorem-studio [setup] [--editor <command>] [--deno-config <file>] [--no-watch] [--quiet] [--offline] [--verbose]
 *
 * That is the installed package's command (`npx theorem-studio`); in the repo it is
 * `node studio/start.mjs`.
 *
 * `setup` is a setup's file or its name. A setup is a file named `studio.setup.ts`, named for its
 * folder, or `<name>.studio.setup.ts`. With no `setup` the project's one setup opens, and when the
 * project has several the command asks which. A project gives this a short name of its own:
 * `"studio": "theorem-studio"` in its scripts makes it `npm run studio`.
 *
 * It starts the project's local server (`server/serve.ts`, under Deno, with the project's own
 * permissions) and the studio's page, and stops both together. Only this machine reaches either.
 * `--editor` names the editor the studio opens a line of the project's files in; without it the
 * studio uses `$VISUAL` or `$EDITOR` when that opens a window, and `code` otherwise. When that one
 * does not start, the machine's default editor opens the file.
 * The studio watches the files the setup reads and takes in what the builder's editor changes;
 * `--no-watch` turns that off, and the studio then reads them when the builder comes back to it.
 * When the project opens the command prints what it loaded (the setup, its entry, the agents
 * with their providers, the tools), what the project has to look at, as the page flags it, and
 * then whether each provider takes its key: one request to each, which `--offline` leaves out.
 * It prints again when what to look at changes, and a line for each run that fails and each
 * error the page meets. `--verbose` adds a line for every run; `--quiet` turns all of it off.
 * The project loads with its own Deno config: the one `--deno-config` names, else the `deno.json`
 * or `deno.jsonc` in the folder the command ran in, else the studio's.
 * A project already open in a studio is not opened twice: the command says where it is. A second
 * project opens beside the first, on the next free pair of ports.
 *
 *   theorem-studio status [setup]
 *   theorem-studio errors [setup] [--follow]
 *
 * read a studio that is open on this project, and change nothing: `status` prints what it loaded,
 * what its keys said and what to look at; `errors` prints the last 200 things it told the
 * terminal, and `--follow` then prints each new one until the studio stops.
 * The studio is opt-in, so this checks for its install and never installs it.
 */
import { builtPage, requireInstalled } from './installed.mjs';
import { heldPairs, pageAddress, placeFor, serverAddress } from './ports.mjs';
import { readStudio, studiosOn } from './read-studio.mjs';
import { chooseSetup, findSetups, setupLines, setupsNamed } from './setups.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const COMMAND = builtPage ? 'theorem-studio' : 'node studio/start.mjs';
const USAGE = `usage: ${COMMAND} [setup] [--editor <command>] [--deno-config <file>] [--no-watch] [--quiet] [--offline] [--verbose]
       ${COMMAND} status [setup]
       ${COMMAND} errors [setup] [--follow]`;
// The setup module is named from where the command was run, which is also the project's name.
const from = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
if (args[0] === 'status' || args[0] === 'errors') await read(args[0], args.slice(1));
requireInstalled();
/** The value after each flag that takes one. A flag with none, a second setup, or anything else, is a mistake. */
const VALUED = ['--editor', '--deno-config'];
const given = {};
let wanted;
let noWatch = false;
let quiet = false;
let offline = false;
let verbose = false;
let mistaken = false;
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at];
  if (arg === '--no-watch') noWatch = true;
  else if (arg === '--quiet') quiet = true;
  else if (arg === '--offline') offline = true;
  else if (arg === '--verbose') verbose = true;
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

const setup = await setupToOpen();

/**
 * Reads the studio open on this project's setup, or on the one named, and stops: the setup to read
 * is found as one to open is, except that only one open in a studio counts.
 */
async function read(command, rest) {
  const follow = command === 'errors' && rest.includes('--follow');
  const named = rest.filter((arg) => arg !== '--follow' || command !== 'errors');
  if (named.length > 1 || named.some((arg) => arg.startsWith('--'))) stopWith(2, USAGE);
  const [name] = named;
  const studio = await studioToRead(name);
  if (command === 'status') {
    console.log(
      `theorem studio: ${path.relative(from, studio.setup)} on ${pageAddress(studio.pair)}/studio/`,
    );
  }
  try {
    await readStudio(studio, command, { follow });
  } catch (error) {
    stopWith(1, `theorem studio: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

/** The setups a read may mean: the file named, else the ones with the name, else all of them. */
function setupsToRead(name) {
  if (name !== undefined && existsSync(path.resolve(from, name))) return [name];
  const found = findSetups(from);
  return (name === undefined ? found : setupsNamed(found, name)).map((one) => one.file);
}

/** The one studio open on those setups; says why there is none, or more than one, and stops. */
async function studioToRead(name) {
  const setups = setupsToRead(name);
  if (name !== undefined && setups.length === 0) {
    stopWith(
      2,
      `theorem studio: no setup is named ${name}. This project has:\n\n${setupLines(findSetups(from)).join('\n')}`,
    );
  }
  const open = studiosOn(
    await heldPairs(),
    new Set(setups.map((file) => realpathSync(path.resolve(from, file)))),
  );
  if (open.length === 0) {
    stopWith(
      1,
      `theorem studio: no studio is open on ${name ?? from}. Open one: ${COMMAND}${name ? ` ${name}` : ''}`,
    );
  }
  if (open.length > 1) {
    stopWith(
      2,
      `theorem studio: more than one studio is open here. Name the setup:\n\n${open.map((one) => `  ${path.relative(from, one.setup)}`).join('\n')}`,
    );
  }
  return open[0];
}

/** Says why the command stops, and stops with `code`. */
function stopWith(code, message) {
  console.error(message);
  process.exit(code);
}

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
  const why = whyNoSetup(found, setups);
  if (why) refuse(why);
  const chosen = await chooseSetup(setups, process.stdin, process.stdout);
  if (!chosen) process.exit(130);
  return chosen.file;
}

/** Why the builder cannot be asked which setup to open, when that is so. */
function whyNoSetup(found, setups) {
  if (found.length === 0) {
    return `No setup in ${from}. A setup is a file named studio.setup.ts, or <name>.studio.setup.ts.`;
  }
  if (setups.length === 0) {
    return `No setup is named ${wanted}. This project has:\n\n${setupLines(found).join('\n')}`;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return `This project has more than one setup. Name the one to open:\n\n${setupLines(setups).join('\n')}`;
  }
  return undefined;
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
  : (ownConfig ?? path.join(here, 'deno.json'));
const server = spawn(
  'deno',
  [
    'run',
    '--config',
    path.join(here, 'deno.json'),
    '-A',
    path.join(here, builtPage ? 'server/serve.js' : 'server/serve.ts'),
    path.resolve(from, setup),
    '--port',
    String(place.pair.server),
    '--page',
    `${PAGE},http://localhost:${String(place.pair.page)}`,
    '--deno-config',
    projectConfig,
    ...(editor ? ['--editor', editor] : []),
    ...(noWatch ? ['--no-watch'] : []),
    ...(quiet ? ['--quiet'] : []),
    ...(offline ? ['--offline'] : []),
    ...(verbose ? ['--verbose'] : []),
  ],
  { cwd: from, stdio: ['ignore', 'ignore', 'inherit'] },
);
const project = `${serverAddress(place.pair)}/api/studio`;
// An installed studio serves the page it was built with; the repo's is Vite on the sources.
const page = builtPage
  ? spawn(
      process.execPath,
      [path.join(here, 'serve-page.mjs'), '--port', String(place.pair.page), '--project', project],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
  : spawn(
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
        env: { ...process.env, THEOREM_STUDIO_PROJECT: project },
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
