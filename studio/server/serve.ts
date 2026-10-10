/**
 * Starts the studio's local server for one project.
 *
 *   deno run -A studio/server/serve.ts <setup-module> [--port 4983] [--page http://localhost:5174]
 *     [--deno-config <deno.json>] [--editor <command>]
 *
 * The setup module is the project's: its default export registers the project's
 * tools, profiles and providers; an optional `host` export gives tool handlers
 * their application context (the test user), and an optional `provider` export
 * says where the providers find their keys. Only this machine can reach the server.
 *
 * The project loads in a process of its own (`project.ts`), and this passes the
 * page's requests on to it. Save is here: it writes the builder's edits into the
 * project's files, checks them, and starts the project again from disk. It writes
 * only files the project's setup imports, inside the folder the command ran in,
 * and it never runs git. Open starts the builder's editor on a line of one of
 * those files: the editor `--editor` names, else `$VISUAL` or `$EDITOR` when it
 * opens in a window, else VS Code.
 *
 * @module
 */

import { dirname, resolve } from 'node:path';
import { corsHeaders, isForeign, json, STUDIO_BASE, type StudioDescription } from './handler.ts';
import { createEditedSession } from './edited-session.ts';
import type { ProjectEdits } from './edits.ts';
import { answerOpen, chosenEditor, type EditorHost } from './open-editor.ts';
import { PROJECT_READY } from './project.ts';
import { isInside } from './project-source.ts';
import { answerSave, createSaveSession, isSaveRequest } from './save-session.ts';

function flag(name: string, fallback: string): string {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 ? (Deno.args[at + 1] ?? fallback) : fallback;
}

const setupPath = Deno.args.find((arg, i) => !arg.startsWith('--') && !Deno.args[i - 1]?.startsWith('--'));
if (!setupPath) {
  console.error(
    'usage: studio/server/serve.ts <setup-module> [--port 4983] [--page http://localhost:5174] [--deno-config deno.json] [--editor code]',
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
async function drain(stream: ReadableStream<Uint8Array>, each: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) each(decoder.decode(chunk, { stream: true }));
}

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
      import.meta.resolve('./project.ts'),
      setupFile,
      '--port',
      String(childPort),
      '--page',
      pageOrigins.join(','),
      ...(edits ? ['--edits'] : []),
    ],
    cwd: root,
    stdin: edits ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  if (edits) {
    const input = process.stdin.getWriter();
    await input.write(new TextEncoder().encode(JSON.stringify(edits)));
    await input.close();
  }
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
    throw new Error(printed.trim() || 'The project did not start.');
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

/** Whether the project type-checks as it is on disk, and what the checker printed. */
async function typeChecks(): Promise<{ ok: boolean; output: string }> {
  const { success, stderr, stdout } = await new Deno.Command(Deno.execPath(), {
    args: ['check', ...configArgs, setupFile],
    cwd: root,
    env: { NO_COLOR: '1' },
    stdin: 'null',
  }).output();
  const decoder = new TextDecoder();
  return { ok: success, output: (decoder.decode(stderr) + decoder.decode(stdout)).trim().slice(-4000) };
}

/** A project file's text, or undefined when it is missing or leads outside the project. */
function readInside(path: string): string | undefined {
  try {
    return isInside(root, Deno.realPathSync(path)) ? Deno.readTextFileSync(path) : undefined;
  } catch {
    return undefined;
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
  },
  first,
);

/** Passes a request on to a load of the project, and its answer back as it streams. */
async function forward(request: Request, loaded = session.project(), path?: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return forwardSocket(request, `${loaded.origin}${path ?? url.pathname}${url.search}`);
  }
  const headers = new Headers(request.headers);
  headers.delete('host');
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  try {
    return await fetch(`${loaded.origin}${path ?? url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
    });
  } catch {
    return json(502, {}, corsHeaders(request, pageOrigins));
  }
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
    if (other.readyState === WebSocket.OPEN || other.readyState === WebSocket.CONNECTING) other.close();
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

const SAVE = `${STUDIO_BASE}/save`;
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
  if (!loaded) return request.method === 'OPTIONS' ? new Response(null, { status: 204, headers: cors }) : json(409, {}, cors);
  return forward(request, loaded, STUDIO_BASE + pathname.slice(EDITED.length));
}

/** Starts a command on its own, without a shell. False when the machine has no such command. */
function start(command: string, args: string[]): boolean {
  try {
    new Deno.Command(command, { args, cwd: root, stdin: 'null', stdout: 'null', stderr: 'null' }).spawn().unref();
    return true;
  } catch {
    return false;
  }
}

const editor: EditorHost = {
  editor: chosenEditor(flag('editor', ''), [Deno.env.get('VISUAL'), Deno.env.get('EDITOR')]),
  place: (file) => session.place(file),
  start,
};

/**
 * The project as the page opens it: what it registered, the settings its files say its profiles
 * share, and the ones they set in code.
 */
function opened(request: Request): StudioDescription | undefined {
  if (request.method !== 'GET' || new URL(request.url).pathname !== STUDIO_BASE) return undefined;
  return { ...session.project().description, shared: session.shared(), origins: session.origins() };
}

Deno.serve({ hostname: '127.0.0.1', port }, async (request) => {
  if (isForeign(request, gate)) return json(403, {}, {});
  const answer = opened(request) ?? (await answerSave(session, SAVE, request)) ??
    (await answerOpen(editor, OPEN, request));
  if (!answer) return (await answerEdited(request)) ?? forward(request);
  const cors = corsHeaders(request, pageOrigins);
  return 'workspace' in answer ? json(200, answer, cors) : json(answer.status, answer.body, cors);
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
