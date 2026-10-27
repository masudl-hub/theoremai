/**
 * Starts the studio's local server for one project.
 *
 *   deno run -A studio/server/serve.ts <setup-module> [--port 4983] [--page http://localhost:5174]
 *     [--deno-config <deno.json>] [--editor <command>] [--no-watch] [--quiet] [--offline] [--verbose]
 *
 * The setup module is the project's: its default export registers the project's
 * tools, profiles, and providers; an optional `host` export gives tool handlers
 * their application context (the test user), and an optional `provider` export
 * says where the providers find their keys. Only this machine can reach the server.
 *
 * The project loads in a process of its own (`project.ts`), and this passes the
 * page's requests on to it, and starts it again when the page asks for a project
 * whose files the builder's editor changed. Save is here: it writes the builder's
 * edits into the project's files, checks them, and starts the project again from
 * disk. It writes only files the project's setup imports, inside the folder the
 * command ran in, and it never runs git. Open starts the builder's editor on a line of one of
 * those files: the editor `--editor` names, else `$VISUAL` or `$EDITOR` when it
 * opens in a window, else VS Code.
 *
 * @module
 */

import { dirname, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { KeyCheck } from '@theoremjs/agents';
import { newConversationKey } from '../conversation-key.ts';
import { RUNNING_PATH } from '../ports.mjs';
import { READ_STEPS, type ReadStep } from '../read-steps.ts';
import { alertText, keyLine, loadedText } from './alerts.ts';
import { createEditedSession } from './edited-session.ts';
import type { ProjectEdits } from './edits.ts';
import { createEventLog, watchRun } from './events.ts';
import {
  corsHeaders,
  isForeign,
  json,
  KEYS_PATH,
  STUDIO_BASE,
  type StudioDescription,
} from './handler.ts';
import { answerOpen, chosenEditor, defaultEditor, type EditorHost } from './open-editor.ts';
import { PROJECT_READY, type ProjectLoad } from './project.ts';
import { entryOf, isInside } from './project-source.ts';
import { answerSave, createSaveSession, isSaveRequest } from './save-session.ts';
import { createWatchFeed, watchFiles } from './watch.ts';

function flag(name: string, fallback: string): string {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? (Deno.args[at + 1] ?? fallback) : fallback;
}

const setupPath = Deno.args.find(
  (arg, i) => !arg.startsWith('--') && !Deno.args[i - 1]?.startsWith('--'),
);
if (!setupPath) {
  console.error(
    'usage: studio/server/serve.ts <setup-module> [--port 4983] [--page http://localhost:5174] [--deno-config deno.json] [--editor code] [--no-watch] [--quiet] [--offline] [--verbose]',
  );
  Deno.exit(2);
}

const port = Number(flag('port', '4983'));
/** The site's dev server, under either name a browser gives this machine. */
const pageOrigins = flag('page', 'http://localhost:5174,http://127.0.0.1:5174').split(',');
const gate = { listenHost: `127.0.0.1:${port}`, pageOrigins };
/** The folder Save may write in: where the command ran. */
const root = Deno.realPathSync(Deno.cwd());
const setupFile = Deno.realPathSync(resolve(setupPath));
/** The project's Deno config, when the command names one: the project loads and type-checks under it. */
const denoConfig = flag('deno-config', '');
const configArgs = denoConfig ? ['--config', denoConfig] : [];

/** The project, loaded: its process, where it listens, and what it opened as. */
interface Loaded {
  process: Deno.ChildProcess;
  origin: string;
  description: StudioDescription;
}

/** A port nothing listens on. */
function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port: free } = listener.addr as Deno.NetAddr;
  listener.close();
  return free;
}

/** Reads a stream to its end, a decoded chunk at a time. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  each: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) each(decoder.decode(chunk, { stream: true }));
}

/** Seals this run's chats. Every load gets it, so a chat outlives a Save; quitting ends it. */
const conversationKey = newConversationKey();

/**
 * Loads the project from disk in a new process, with the builder's unsaved `edits` laid over it
 * when there are some. Throws what it printed when it does not start.
 */
async function loadProject(edits?: ProjectEdits): Promise<Loaded> {
  const childPort = freePort();
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      ...configArgs,
      '-A',
      // why: The installed package runs this file built to JavaScript, beside a built `project.js`.
      import.meta.resolve(import.meta.url.endsWith('.js') ? './project.js' : './project.ts'),
      setupFile,
      '--port',
      String(childPort),
      '--page',
      pageOrigins.join(','),
    ],
    cwd: root,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const load: ProjectLoad = { conversationKey, ...(edits ? { edits } : {}) };
  const input = process.stdin.getWriter();
  await input.write(new TextEncoder().encode(JSON.stringify(load)));
  await input.close();
  let printed = '';
  const errors = drain(process.stderr, (text) => {
    printed = (printed + text).slice(-4000);
    Deno.stderr.writeSync(new TextEncoder().encode(text));
  });
  let ready: () => void = () => {};
  const listening = new Promise<boolean>((settle) => {
    let out = '';
    ready = () => settle(true);
    drain(process.stdout, (text) => {
      out = (out + text).slice(-200);
      if (out.includes(PROJECT_READY)) ready();
    }).then(() => settle(false));
  });
  if (!(await listening)) {
    await Promise.all([process.status, errors]);
    // The page shows this, so the terminal's colours come out.
    throw new Error(stripVTControlCharacters(printed).trim() || 'The project did not start.');
  }
  const origin = `http://127.0.0.1:${childPort}`;
  const description: StudioDescription = await (await fetch(origin + STUDIO_BASE)).json();
  return { process, origin, description };
}

async function stop(loaded: Loaded): Promise<void> {
  try {
    loaded.process.kill();
  } catch {
    // It had already ended.
  }
  await loaded.process.status;
}

/** Whether the project type-checks as it is on disk, from the setup and the entry it names, and what the checker printed. */
async function typeChecks(): Promise<{ ok: boolean; output: string }> {
  const entry = entryOf(setupFile);
  const { success, stderr, stdout } = await new Deno.Command(Deno.execPath(), {
    args: ['check', ...configArgs, setupFile, ...(entry ? [entry] : [])],
    cwd: root,
    env: { NO_COLOR: '1' },
    stdin: 'null',
  }).output();
  const decoder = new TextDecoder();
  return {
    ok: success,
    output: (decoder.decode(stderr) + decoder.decode(stdout)).trim().slice(-4000),
  };
}

/** A project file's text, or undefined when it is missing or leads outside the project. */
function readInside(path: string): string | undefined {
  try {
    return isInside(root, Deno.realPathSync(path)) ? Deno.readTextFileSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a write to a path lands inside the project. A link where the file would go, or in a
 * folder on the way to it, can lead anywhere on the machine; a project from someone else can hold one.
 */
function landsInside(path: string): boolean {
  try {
    if (Deno.lstatSync(path).isSymlink) return false;
  } catch {
    // No file there yet.
  }
  for (let folder = dirname(path); ; folder = dirname(folder)) {
    try {
      return isInside(root, Deno.realPathSync(folder));
    } catch {
      // That folder is not made yet: the one above it decides.
      if (folder === dirname(folder)) return false;
    }
  }
}

let first: Loaded;
try {
  first = await loadProject();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  Deno.exit(1);
}
/** The load that runs the builder's unsaved edits, while the page compares it with the files. */
const edited = createEditedSession<Loaded>({
  load: loadProject,
  stop,
  opened: (loaded) => loaded.description.workspace,
});
const session = createSaveSession<Loaded>(
  {
    root,
    setupFile,
    read: readInside,
    landsInside,
    write: (path, text) => {
      Deno.mkdirSync(dirname(path), { recursive: true });
      Deno.writeTextFileSync(path, text);
    },
    remove: (path) => Deno.removeSync(path),
    typeChecks,
    // The files changed: the edited load lies over files that are gone.
    load: async () => {
      await edited.close();
      return loadProject();
    },
    stop,
    opened: (loaded) => loaded.description.workspace,
    unopened: (loaded) => loaded.description.problems.map((problem) => problem.profile),
  },
  first,
);

/** Passes a request on to a load of the project, and its answer back as it streams. */
async function forward(
  request: Request,
  loaded = session.project(),
  path?: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return forwardSocket(request, `${loaded.origin}${path ?? url.pathname}${url.search}`);
  }
  const headers = new Headers(request.headers);
  headers.delete('host');
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const to = path ?? url.pathname;
  let response: Response;
  try {
    response = await fetch(`${loaded.origin}${to}${url.search}`, {
      method: request.method,
      headers,
      body,
    });
  } catch {
    return json(502, {}, corsHeaders(request, pageOrigins));
  }
  return request.method === 'OPTIONS' ? response : watchedRun(request.method, to, response);
}

/** A run's answer, watched for a failure to tell the terminal of; any other answer as it is. */
function watchedRun(method: string, to: string, response: Response): Response {
  const profile = to.startsWith(PROFILES)
    ? decodeURIComponent(to.slice(PROFILES.length).split('/')[0] ?? '')
    : undefined;
  if (profile === undefined) return response;
  if (verbose)
    console.error(
      `theorem studio: run ${profile} ${method} ${to.slice(PROFILES.length + profile.length) || '/'} → ${response.status}`,
    );
  return watchRun(response, (said) => tell('run', `run ${profile} failed: ${said}`));
}

/**
 * Joins the page's socket to the same path of the project: a voice call. What the page sends
 * before the project's side opens is held, because a call opens with the page's first message.
 */
function forwardSocket(request: Request, to: string): Response {
  const { socket: page, response } = Deno.upgradeWebSocket(request);
  const project = new WebSocket(to.replace(/^http/, 'ws'));
  page.binaryType = 'arraybuffer';
  project.binaryType = 'arraybuffer';
  const held: (string | ArrayBuffer)[] = [];
  const shut = (other: WebSocket) => () => {
    if (other.readyState === WebSocket.OPEN || other.readyState === WebSocket.CONNECTING)
      other.close();
  };
  page.addEventListener('message', (event) => {
    if (project.readyState === WebSocket.OPEN) project.send(event.data);
    else held.push(event.data);
  });
  project.addEventListener('open', () => {
    for (const data of held.splice(0)) project.send(data);
  });
  project.addEventListener('message', (event) => {
    if (page.readyState === WebSocket.OPEN) page.send(event.data);
  });
  page.addEventListener('close', shut(project));
  project.addEventListener('close', shut(page));
  project.addEventListener('error', shut(page));
  return response;
}

/** Where the project serves each profile's runs. */
const PROFILES = `${STUDIO_BASE}/profiles/`;
const EVENTS = `${STUDIO_BASE}/events`;
const STATUS = `${STUDIO_BASE}/status`;
const SAVE = `${STUDIO_BASE}/save`;
const WATCH = `${STUDIO_BASE}/watch`;
const OPEN = `${STUDIO_BASE}/open`;
const EDITED = `${STUDIO_BASE}/edited`;

/**
 * The edited load: a POST of the workspace at `EDITED` starts it, and every path under it is the
 * same path of the project, answered by that load. Undefined when the request is not for it.
 */
async function answerEdited(request: Request): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  const cors = corsHeaders(request, pageOrigins);
  if (pathname === EDITED && request.method === 'POST') {
    const body: unknown = await request.json().catch(() => null);
    if (!isSaveRequest(body)) return json(400, {}, cors);
    return json(200, await edited.open(body.workspace, session.project()), cors);
  }
  if (!pathname.startsWith(`${EDITED}/`)) return undefined;
  const loaded = edited.running();
  // No load holds the edits: the page asks for one again. A preflight is still answered, so the
  // page reads that and not a blocked request.
  if (!loaded)
    return request.method === 'OPTIONS'
      ? new Response(null, { status: 204, headers: cors })
      : json(409, {}, cors);
  return forward(request, loaded, STUDIO_BASE + pathname.slice(EDITED.length));
}

/** Starts a command on its own, without a shell. False when the machine has no such command. */
function start(command: string, args: string[]): boolean {
  try {
    new Deno.Command(command, { args, cwd: root, stdin: 'null', stdout: 'null', stderr: 'null' })
      .spawn()
      .unref();
    return true;
  } catch {
    return false;
  }
}

const editor: EditorHost = {
  editor: chosenEditor(flag('editor', ''), [Deno.env.get('VISUAL'), Deno.env.get('EDITOR')]),
  place: (file) => session.place(file),
  start,
  os: Deno.build.os,
  home: Deno.env.get('HOME'),
};

/**
 * The project as the page opens it: what it registered, the settings its files say its profiles
 * share, and the ones they set in code. Files the builder's editor changed are loaded first.
 */
async function described(said?: (step: ReadStep) => void): Promise<StudioDescription> {
  const files = await session.read(said);
  const description = {
    ...session.project().description,
    ...files,
    editor: defaultEditor(editor),
    setup: relative(root, setupFile),
  };
  tellTerminal(description);
  return description;
}

/** Whether the command was started without printing anything about the project. */
const quiet = Deno.args.includes('--quiet');
/** Whether the command also prints each run as it ends, not only the ones that fail. */
const verbose = Deno.args.includes('--verbose');
/** Whether the command was started without asking each provider whether its key works. */
const offline = Deno.args.includes('--offline');
/** What the key checks said: none until they answer. */
let keysSaid: string[] | undefined;

/** The entry the setup names, from the folder the command ran in. */
function entryAt(): { entry?: string } {
  const entry = entryOf(setupFile);
  return entry ? { entry: relative(root, entry) } : {};
}
/** What happened that the builder should know of, for `theorem-studio errors` to read. */
const events = createEventLog();
/** What was printed last: `null` before the first print, so a clean project still says so. */
let told: string | undefined | null = null;

/** Keeps an event and prints it, unless it repeats the last one or the command is quiet. */
function tell(kind: 'key' | 'run' | 'page', text: string): void {
  if (events.add(kind, text) && !quiet) console.error(`theorem studio: ${text}`);
}

/** Prints what the builder should look at when it is not what was printed last. */
function tellTerminal(description: StudioDescription): void {
  const text = alertText(description);
  if (text === told) return;
  const first = told === null;
  told = text;
  const said = text ?? `theorem studio: nothing ${first ? '' : 'left '}to look at`;
  // why: a project that opens clean has nothing to keep; one that comes clean later does.
  if (!(first && text === undefined)) events.add('look', said);
  if (!quiet) console.error(said);
}

/** Whether the request asks for the project as the page opens it, and whether for the steps of reading it first. */
function opens(request: Request): { steps: boolean } | undefined {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== STUDIO_BASE) return undefined;
  return { steps: url.searchParams.has(READ_STEPS) };
}

async function opened(request: Request): Promise<StudioDescription | undefined> {
  return opens(request)?.steps === false ? await described() : undefined;
}

/**
 * The project as the page opens it, after each step of reading it: a line of JSON for each
 * step as it happens, then one holding the project.
 */
function openedSaying(request: Request): Response | undefined {
  if (!opens(request)?.steps) return undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const line = (said: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(said)}\n`));
      described(line).then(
        (project) => {
          line({ opened: project });
          controller.close();
        },
        (error) => controller.error(error),
      );
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      ...corsHeaders(request, pageOrigins),
    },
  });
}

/** Tells the page when the builder's editor writes a file the setup reads, unless `--no-watch` says not to. */
const feed = Deno.args.includes('--no-watch') ? undefined : createWatchFeed();
if (feed) {
  watchFiles({
    files: () => session.watched(),
    changed: () => session.changed(),
    tell: feed.tell,
    watch: (folders) => Deno.watchFs(folders, { recursive: false }),
  });
}

/** The page's subscription to file changes. No content when the studio was started without watching. */
function watching(request: Request): Response | undefined {
  if (request.method !== 'GET' || new URL(request.url).pathname !== WATCH) return undefined;
  const cors = corsHeaders(request, pageOrigins);
  return feed ? feed.subscribe(cors) : new Response(null, { status: 204, headers: cors });
}

/**
 * `GET <base>/status`: what the command printed when the project opened, as it is now: what
 * loaded, what the keys said, and what to look at. Plain text, for `theorem-studio status`.
 */
async function answerStatus(request: Request): Promise<Response | undefined> {
  if (request.method !== 'GET' || new URL(request.url).pathname !== STATUS) return undefined;
  // why: the files are read again, so status agrees with them even when no page has asked since.
  const description = await described();
  const keys = offline ? 'offline' : (keysSaid ?? 'checking');
  const look = alertText(description) ?? 'theorem studio: nothing to look at';
  return new Response(`${loadedText(description, { ...entryAt(), keys })}\n${look}\n`, {
    headers: { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(request, pageOrigins) },
  });
}

/** The longest error the page may send. */
const PAGE_ERROR_BYTES = 8000;

/**
 * The event log: `GET` lists it, `GET ?follow` streams it, and the page `POST`s `{ text }` for an
 * error it met, which the log keeps as the page's.
 */
async function answerEvents(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== EVENTS) return undefined;
  const cors = corsHeaders(request, pageOrigins);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET') {
    return url.searchParams.has('follow') ? events.follow(cors) : json(200, events.list(), cors);
  }
  if (request.method !== 'POST') return json(405, {}, cors);
  const sent = await request.text();
  if (sent.length > PAGE_ERROR_BYTES) return json(413, {}, cors);
  const text = pageError(sent);
  if (!text) return json(400, {}, cors);
  tell('page', `the page: ${text}`);
  return json(200, {}, cors);
}

/** The error a page sent as `{ text }`, trimmed; nothing when it sent no text. */
function pageError(sent: string): string | undefined {
  try {
    const { text } = JSON.parse(sent) as { text?: unknown };
    return typeof text === 'string' ? text.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** The setup this studio is open on, for a second studio command to find it already running. */
function running(request: Request): Response | undefined {
  if (request.method !== 'GET' || new URL(request.url).pathname !== RUNNING_PATH) return undefined;
  return json(200, { setup: setupFile }, corsHeaders(request, pageOrigins));
}

/** What the studio answers itself: the project as it opens, a save, or the builder's editor on a line. */
async function answered(request: Request): Promise<Response | undefined> {
  const answer =
    (await opened(request)) ??
    (await answerSave(session, SAVE, request)) ??
    (await answerOpen(editor, OPEN, request));
  if (!answer) return undefined;
  const cors = corsHeaders(request, pageOrigins);
  return 'workspace' in answer ? json(200, answer, cors) : json(answer.status, answer.body, cors);
}

/** The studio's own routes, in the order they are asked; a request none answers goes to the project. */
const ROUTES: ((request: Request) => Response | undefined | Promise<Response | undefined>)[] = [
  running,
  watching,
  openedSaying,
  answerStatus,
  answerEvents,
  answered,
  answerEdited,
];

Deno.serve({ hostname: '127.0.0.1', port, onListen: () => {} }, async (request) => {
  if (isForeign(request, gate)) return json(403, {}, {});
  for (const route of ROUTES) {
    const response = await route(request);
    if (response) return response;
  }
  return forward(request);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => {
    for (const loaded of [session.project(), edited.running()]) {
      try {
        loaded?.process.kill();
      } catch {
        // It had already ended.
      }
    }
    Deno.exit(0);
  });
}
console.log(`Theorem Studio: open ${pageOrigins[0]}/studio (server on http://127.0.0.1:${port})`);
if (!quiet) {
  console.error(
    loadedText(
      { ...first.description, setup: relative(root, setupFile) },
      { ...entryAt(), keys: offline ? 'offline' : 'checking' },
    ),
  );
}
// The project is read once now, so what it has to look at reaches the terminal before the page opens.
await described().catch((error) => console.error(error instanceof Error ? error.message : error));
// One request for each provider's key, once: the keys are read as the project loads.
if (!offline) {
  fetch(session.project().origin + KEYS_PATH)
    .then((response) => response.json() as Promise<KeyCheck[]>)
    .then((checks) => {
      keysSaid = checks.map(keyLine);
      for (const [at, check] of checks.entries()) {
        const line = keysSaid[at] ?? '';
        // A key that works is said once, here, and is not kept as something that went wrong.
        if (check.state === 'accepted') {
          if (!quiet) console.error(`theorem studio: ${line}`);
        } else tell('key', line);
      }
    })
    .catch((error) => {
      keysSaid = [`not checked: ${error}`];
      tell('key', `the keys were not checked: ${error}`);
    });
}
