/**
 * The studio's server, run as a builder runs it, on a copy of a project written to be hard to
 * read and hard to write back: line endings and tabs, aliased and namespaced imports, spreads,
 * factories and several definitions to a file. It is driven the way the page drives it, and the
 * way a hostile page or a careless editor would.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import type { StudioDescription } from '../../studio/server/handler.ts';
import type { SaveDone, SaveRefusal, SaveReview } from '../../studio/server/save-wire.ts';
import { removeLibraryTool, type StudioWorkspace, setToolAllowed } from '../../studio/workspace.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(REPO, 'tests/fixtures/studio-project');
const SERVE = join(REPO, 'studio/server/serve.ts');
const SETUP = 'adv.studio.setup.ts';
const PAGE = 'http://page.localhost:5174';

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Every file under `folder`, by its path from it, as bytes. */
function snapshot(folder: string, under = ''): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of Deno.readDirSync(join(folder, under))) {
    const path = join(under, entry.name);
    if (entry.isDirectory)
      for (const [file, bytes] of snapshot(folder, path)) files.set(file, bytes);
    else if (entry.isFile) files.set(path, Deno.readFileSync(join(folder, path)));
  }
  return files;
}

function copy(from: string, to: string): void {
  for (const [file, bytes] of snapshot(from)) {
    Deno.mkdirSync(dirname(join(to, file)), { recursive: true });
    Deno.writeFileSync(join(to, file), bytes);
  }
}

/** Puts the project back as it was, file for file, when a step failed partway. */
function restore(root: string, original: Map<string, Uint8Array>): void {
  const now = snapshot(root);
  for (const file of now.keys()) if (!original.has(file)) Deno.removeSync(join(root, file));
  for (const [file, bytes] of original) {
    const held = now.get(file);
    if (held && held.length === bytes.length && held.every((byte, at) => byte === bytes[at]))
      continue;
    Deno.mkdirSync(dirname(join(root, file)), { recursive: true });
    Deno.writeFileSync(join(root, file), bytes);
  }
}

/** The project's files, compared as bytes so a lost carriage return fails. */
function assertSameFiles(actual: Map<string, Uint8Array>, expected: Map<string, Uint8Array>): void {
  assertEquals([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [file, bytes] of expected) assertEquals(actual.get(file), bytes, file);
}

interface Studio {
  /** The folder the project sits in, with the files beside it. */
  base: string;
  root: string;
  /** What the editor was asked to open, a line each. */
  opened(): string;
  /** A file beside the project, where no Save may write. */
  outside: string;
  port: number;
  call(path: string, init?: RequestInit & { origin?: string | null }): Promise<Response>;
  post<T>(path: string, body: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

/** Copies the project into a folder of its own and starts the studio's server on it. */
async function startStudio(): Promise<Studio> {
  const base = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'studio-e2e-' }));
  const root = join(base, 'project');
  copy(FIXTURE, root);
  Deno.writeTextFileSync(
    join(root, 'deno.json'),
    JSON.stringify({
      imports: { '@theoremjs/agents': 'jsr:@theoremjs/agents@^0.3.0', zod: 'npm:zod@^4.6.5' },
      links: [REPO],
    }),
  );
  const outside = join(base, 'outside.txt');
  Deno.writeTextFileSync(outside, 'not the project\n');
  // The editor the studio starts is this script, so no test opens a window on the machine.
  const editor = join(base, 'bin', 'code');
  Deno.mkdirSync(dirname(editor));
  Deno.writeTextFileSync(editor, `#!/bin/sh\necho "$@" >> '${join(base, 'opened.log')}'\n`, {
    mode: 0o755,
  });
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '-A',
      SERVE,
      SETUP,
      '--port',
      String(port),
      '--page',
      PAGE,
      '--deno-config',
      'deno.json',
      '--editor',
      editor,
    ],
    cwd: root,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let printed = '';
  const decoder = new TextDecoder();
  const read = (stream: ReadableStream<Uint8Array>) =>
    (async () => {
      for await (const chunk of stream) printed += decoder.decode(chunk, { stream: true });
    })();
  const reading = Promise.all([read(child.stdout), read(child.stderr)]);
  for (let waited = 0; !printed.includes('Theorem Studio: open'); waited += 50) {
    if (waited > 60_000) throw new Error(`The studio did not start:\n${printed}`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
  const call = (path: string, init: RequestInit & { origin?: string | null } = {}) => {
    const { origin = PAGE, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (origin !== null) headers.set('origin', origin);
    return fetch(`http://127.0.0.1:${port}${path}`, { ...rest, headers });
  };
  return {
    base,
    root,
    opened: () => {
      try {
        return Deno.readTextFileSync(join(base, 'opened.log'));
      } catch {
        return '';
      }
    },
    outside,
    port,
    call,
    post: async <T>(path: string, body: unknown) => {
      const response = await call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as T };
    },
    close: async () => {
      child.kill('SIGTERM');
      await child.status;
      await reading;
    },
  };
}

async function open(studio: Studio): Promise<StudioDescription> {
  const response = await studio.call('/api/studio');
  assertEquals(response.status, 200);
  return await response.json();
}

/** The workspace with the first agent's handle changed. */
function renamed(workspace: StudioWorkspace, handle: string): StudioWorkspace {
  const [agent, ...rest] = workspace.agents;
  assert(agent);
  return { ...workspace, agents: [{ ...agent, identity: { ...agent.identity, handle } }, ...rest] };
}

type Provider = StudioWorkspace['providers'][number];

/** The workspace with one provider changed. */
function withProvider(
  workspace: StudioWorkspace,
  id: string,
  change: (provider: Provider) => Provider,
): StudioWorkspace {
  return {
    ...workspace,
    providers: workspace.providers.map((provider) =>
      provider.id === id ? change(provider) : provider,
    ),
  };
}

const atBase =
  (baseUrl: string) =>
  (provider: Provider): Provider => ({
    ...provider,
    connection: { ...provider.connection, baseUrl },
  });

type Tool = StudioWorkspace['toolSpecs'][number];
type Agent = StudioWorkspace['agents'][number];

/** The workspace with one tool changed. */
function withTool(
  workspace: StudioWorkspace,
  name: string,
  change: (tool: Tool) => Tool,
): StudioWorkspace {
  return {
    ...workspace,
    toolSpecs: workspace.toolSpecs.map((tool) => (tool.toolName === name ? change(tool) : tool)),
  };
}

/** The workspace with one agent changed. */
function withAgent(
  workspace: StudioWorkspace,
  id: string,
  change: (agent: Agent) => Agent,
): StudioWorkspace {
  return {
    ...workspace,
    agents: workspace.agents.map((agent) =>
      agent.identity.agentId === id ? change(agent) : agent,
    ),
  };
}

const toolKey = (workspace: StudioWorkspace, name: string) =>
  workspace.toolSpecs.find((tool) => tool.toolName === name)?.key ?? '';
const agentKey = (workspace: StudioWorkspace, id: string) =>
  workspace.agents.find((agent) => agent.identity.agentId === id)?.key ?? '';

/** A request written by hand, for the headers a browser's fetch will not let a page set. */
async function raw(port: number, head: string): Promise<string> {
  const connection = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    await connection.write(
      new TextEncoder().encode(`${head.trim().replaceAll('\n', '\r\n')}\r\n\r\n`),
    );
    const buffer = new Uint8Array(4096);
    const read = await connection.read(buffer);
    return new TextDecoder().decode(buffer.subarray(0, read ?? 0));
  } finally {
    connection.close();
  }
}

/** Whether any process still names `folder` in its command line. */
async function running(folder: string): Promise<boolean> {
  const { stdout } = await new Deno.Command('pgrep', {
    args: ['-f', folder],
    stdout: 'piped',
  }).output();
  return new TextDecoder().decode(stdout).trim() !== '';
}

const SAVE = '/api/studio/save';

/** A JSON POST, as the page sends one. */
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** A turn's input: one user message. */
const ask = (text: string) => ({
  input: { messages: [{ role: 'user', parts: [{ type: 'text', text }] }] },
});

/** A line of a run's stream, as far as these steps read it. */
interface Line {
  type?: string;
  text?: string;
  tool?: { phase?: string; name?: string; output?: unknown };
  stop?: { kind?: string };
}

/** Posts `body` to a run and reads back every line it streams. */
async function lines(studio: Studio, path: string, body: unknown): Promise<Line[]> {
  const response = await studio.call(path, post(body));
  const text = await response.text();
  assertEquals(response.status, 200, text);
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const replyOf = (turn: Line[]) =>
  turn
    .filter((line) => line.type === 'text')
    .map((line) => line.text)
    .join('');

/** Reviews and writes `workspace`, and answers the files written. */
async function saved(studio: Studio, workspace: StudioWorkspace): Promise<string[]> {
  const review = await studio.post<SaveReview>(SAVE, { workspace });
  assert(review.body.ok && review.body.writable, JSON.stringify(review.body));
  const done = await studio.post<SaveDone | SaveRefusal>(SAVE, {
    workspace,
    stamp: review.body.stamp,
  });
  assert(done.body.ok, JSON.stringify(done.body));
  return done.body.written;
}

/** Undoes the last save, which wrote `files`, and checks the project is as it was. */
async function undone(
  studio: Studio,
  files: string[],
  original: Map<string, Uint8Array>,
): Promise<void> {
  assertEquals((await studio.post(`${SAVE}/undo`, {})).body, { ok: true, written: files });
  assertSameFiles(snapshot(studio.root), original);
}

Deno.test(
  {
    name: 'the studio server, on a hard project, as a builder and as an attacker',
    sanitizeResources: false,
    sanitizeOps: false,
  },
  async (t) => {
    const studio = await startStudio();
    const original = snapshot(studio.root);
    const bytesOf = (file: string) => {
      const bytes = original.get(file);
      assert(bytes, file);
      return bytes;
    };
    try {
      let opened: StudioDescription = await open(studio);
      // A step that fails partway leaves the project as it found it, so the next one tests what it says.
      const step = (name: string, run: () => Promise<void> | void) =>
        t.step(name, async () => {
          try {
            await run();
          } finally {
            restore(studio.root, original);
            opened = await open(studio);
          }
        });

      await step('opens the project with every provider and agent it registers', () => {
        const agents = opened.workspace.agents.map((agent) => [
          agent.identity.agentId,
          agent.identity.profileType,
        ]);
        assertEquals(agents, [
          ['desk', 'text'],
          ['concierge', 'text'],
          ['gatekeeper', 'host'],
          ['triage', 'decision'],
        ]);
        const tools = opened.workspace.toolSpecs.map((tool) => [tool.toolName, tool.toolType]);
        assertEquals(tools, [
          ['lookup_city', 'function'],
          ['fetch_rates', 'http'],
          ['wipe_desk', 'function'],
        ]);
        assertEquals([opened.problems, opened.unregistered], [[], []]);
        // Every model runs as the files set it, the one on the project's own definition too.
        assertEquals(opened.modelProblems, undefined);
        assertEquals(
          opened.shared?.map((setting) => [setting.name, setting.tools]),
          [['READ', ['lookup_city', 'fetch_rates']]],
        );
        assertEquals(
          opened.workspace.providers.map((provider) => provider.id),
          ['house', 'router', 'left', 'right', 'spaced', 'made-a', 'made-b', 'odd', 'own'],
        );
      });

      await step(
        'the project as it opened reviews as unchanged: nothing to write, nothing refused',
        async () => {
          const review = await studio.post<SaveReview>(SAVE, { workspace: opened.workspace });
          assertEquals(
            [review.body.ok, review.body.files, review.body.writable],
            [true, [], false],
            JSON.stringify(review.body),
          );
        },
      );

      await step(
        'each agent runs as the files make it, on the keys the project holds',
        async () => {
          const turn = await lines(
            studio,
            '/api/studio/profiles/desk/turn',
            ask('Where is Lisbon?'),
          );
          const looked = turn.find(
            (line) => line.type === 'tool' && line.tool?.phase === 'complete',
          );
          assertEquals(
            looked?.tool?.output,
            { city: 'Lisbon', country: 'PT' },
            JSON.stringify(turn),
          );
          assert(replyOf(turn).startsWith('Found:'), JSON.stringify(turn));
          // Two providers share one definition and one key slot; the second agent reaches the script on it.
          const concierge = await lines(
            studio,
            '/api/studio/profiles/concierge/turn',
            ask('And Porto?'),
          );
          assert(replyOf(concierge).startsWith('Found:'), JSON.stringify(concierge));
          const call = await lines(studio, '/api/studio/profiles/gatekeeper/call', {
            name: 'lookup_city',
            input: { city: 'Porto' },
          });
          assertEquals(call.at(-1)?.stop?.kind, 'completed');
          const gated = await lines(studio, '/api/studio/profiles/gatekeeper/call', {
            name: 'wipe_desk',
            input: { confirm: true },
          });
          assertEquals(gated.at(-1)?.stop?.kind, 'gate');
          assertEquals(
            gated.some((line) => line.tool?.phase === 'complete'),
            false,
          );
          // The decision's provider names no key slot, so the kernel's own refusal is what the page reads.
          const unkeyed = await studio.call(
            '/api/studio/profiles/triage/decide',
            post({ state: { action: 'delete' } }),
          );
          assertEquals([unkeyed.status, (await unkeyed.json()).errorKind], [401, 'auth']);
        },
      );

      await step(
        'the builder gives a provider its key slot in the studio, and the decision runs',
        async () => {
          const workspace = withProvider(opened.workspace, 'spaced', (provider) => ({
            ...provider,
            keySlot: 'spaced_key',
          }));
          const done = await saved(studio, workspace);
          assertEquals(done, ['providers/ns.ts']);
          assert(
            Deno.readTextFileSync(join(studio.root, 'providers/ns.ts')).includes(
              "keySlot: 'spaced_key'",
            ),
          );
          const decided = await studio.call(
            '/api/studio/profiles/triage/decide',
            post({ state: { action: 'delete' } }),
          );
          const answer = await decided.json();
          await undone(studio, ['providers/ns.ts'], original);
          assertEquals(
            [decided.status, answer.result?.answers?.next?.choice],
            [200, 'ask'],
            JSON.stringify(answer),
          );
          opened = await open(studio);
        },
      );

      await step(
        'a save reviews, writes the reviewed bytes, and undo restores them exactly',
        async () => {
          const workspace = renamed(opened.workspace, 'Desk Two');
          const review = await studio.post<SaveReview>(SAVE, { workspace });
          assertEquals(review.status, 200);
          assert(review.body.ok && review.body.writable, JSON.stringify(review.body));
          assertSameFiles(snapshot(studio.root), original);
          const done = await studio.post<SaveDone | SaveRefusal>(SAVE, {
            workspace,
            stamp: review.body.stamp,
          });
          assertEquals(done.body, { ok: true, written: ['agents/desk.ts'] });
          assertNotEquals(
            snapshot(studio.root).get('agents/desk.ts'),
            original.get('agents/desk.ts'),
          );
          opened = await open(studio);
          assertEquals(opened.workspace.agents[0]?.identity.handle, 'Desk Two');
          const undone = await studio.post<SaveDone | SaveRefusal>(`${SAVE}/undo`, {});
          assertEquals(undone.body, { ok: true, written: ['agents/desk.ts'] });
          assertSameFiles(snapshot(studio.root), original);
          opened = await open(studio);
        },
      );

      await step(
        'a page on another site, or a name pointed at this machine, is refused everywhere',
        async () => {
          const paths: [string, RequestInit][] = [
            ['/api/studio', {}],
            ['/api/studio?steps', {}],
            ['/api/studio/watch', {}],
            ['/api/studio/running', {}],
            [SAVE, { method: 'POST', body: JSON.stringify({ workspace: opened.workspace }) }],
            [`${SAVE}/undo`, { method: 'POST', body: '{}' }],
            ['/api/studio/open', { method: 'POST', body: JSON.stringify({ file: SETUP }) }],
            [
              '/api/studio/edited',
              { method: 'POST', body: JSON.stringify({ workspace: opened.workspace }) },
            ],
            ['/api/studio/edited/api/studio', {}],
            ['/api/studio/chat', { method: 'POST', body: '{}' }],
            ['/anything', {}],
          ];
          const origins = [
            'http://evil.example',
            'null',
            `${PAGE}.evil.example`,
            'http://page.localhost:5175',
            PAGE.toUpperCase(),
            `${PAGE}/`,
          ];
          for (const origin of origins) {
            for (const [path, init] of paths) {
              const response = await studio.call(path, { ...init, origin });
              await response.body?.cancel();
              assertEquals(response.status, 403, `${origin} ${path}`);
              assertEquals(
                response.headers.get('access-control-allow-origin'),
                null,
                `${origin} ${path}`,
              );
            }
          }
          for (const head of [
            `GET /api/studio HTTP/1.1\nHost: evil.example\nOrigin: ${PAGE}`,
            `GET /api/studio HTTP/1.1\nHost: localhost:${studio.port}\nOrigin: ${PAGE}`,
            `GET /api/studio HTTP/1.1\nHost: 127.0.0.1:${studio.port}\nSec-Fetch-Site: cross-site`,
            `GET /api/studio HTTP/1.1\nHost: 127.0.0.1:${studio.port}\nOrigin: ${PAGE}\nHost: evil.example`,
            `GET /api/studio/live HTTP/1.1\nHost: 127.0.0.1:${studio.port}\nOrigin: http://evil.example\nUpgrade: websocket\nConnection: Upgrade\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\nSec-WebSocket-Version: 13`,
            `GET /api/studio/live HTTP/1.1\nHost: 127.0.0.1:${studio.port}\nUpgrade: websocket\nConnection: Upgrade\nSec-Fetch-Site: cross-site\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\nSec-WebSocket-Version: 13`,
          ]) {
            const answer = await raw(studio.port, head);
            assert(/^HTTP\/1\.1 (403|400)/.test(answer), `${head}\n---\n${answer}`);
          }
          assertSameFiles(snapshot(studio.root), original);
          assertEquals(studio.opened(), '');
        },
      );

      await step(
        'bodies that are not a save are refused, and the server keeps answering',
        async () => {
          const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
          const { workspace } = opened;
          const bodies: unknown[] = [
            'not json',
            '',
            'null',
            '[]',
            '"workspace"',
            deep,
            { workspace: null },
            { workspace: [] },
            { workspace: { agents: {}, toolSpecs: [], starts: { agents: {}, tools: {} } } },
            { workspace: { agents: [null], toolSpecs: ['x'], starts: { agents: [], tools: {} } } },
            { workspace: { agents: [1], toolSpecs: [{}], starts: { agents: {}, tools: {} } } },
            { workspace: { ...workspace, agents: [{ ...workspace.agents[0], identity: null }] } },
            { workspace: { ...workspace, agents: [{ ...workspace.agents[0], key: '__proto__' }] } },
            { workspace: { ...workspace, providers: null } },
            { workspace: { ...workspace, providers: [{ id: 'house' }, 7] } },
            {
              workspace: {
                ...workspace,
                providers: [{ ...workspace.providers[0], connection: { baseUrl: 7 } }],
              },
            },
            { workspace: { ...workspace, starts: null } },
            { workspace: { ...workspace, v: 999 } },
            { workspace, stamp: 12 },
            { workspace, stamp: { toString: 'x' } },
            JSON.parse(
              '{"workspace": {"agents": [], "toolSpecs": [], "starts": {"agents": {}, "tools": {}}}, "__proto__": {"stamp": "x"}}',
            ),
            { workspace: renamed(workspace, 'x'.repeat(5_000_000)) },
          ];
          for (const path of [SAVE, '/api/studio/edited', '/api/studio/open']) {
            for (const body of bodies) {
              const response = await studio.call(path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: typeof body === 'string' ? body : JSON.stringify(body),
              });
              const text = await response.text();
              const label = `${path} ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 120)}`;
              assert(
                response.status === 400 || response.status === 200,
                `${label}: ${response.status} ${text.slice(0, 300)}`,
              );
              const answer = JSON.parse(text);
              if (response.status === 200 && path === SAVE)
                assertNotEquals(answer.written !== undefined, true, label);
            }
            assertEquals((await studio.call('/api/studio')).status, 200);
          }
          assertSameFiles(snapshot(studio.root), original);
          assertEquals(studio.opened(), '');
          opened = await open(studio);
        },
      );

      await step(
        'a save to a file with carriage returns and tabs keeps them, and undo is byte for byte',
        async () => {
          const workspace = withProvider(opened.workspace, 'house', (provider) => ({
            ...atBase('https://changed.example/v1')(provider),
            keySlot: 'changed_key',
            fallbackKeySlot: 'changed_spare',
          }));
          const review = await studio.post<SaveReview>(SAVE, { workspace });
          assert(review.body.writable, JSON.stringify(review.body));
          const done = await studio.post<SaveDone>(SAVE, { workspace, stamp: review.body.stamp });
          assertEquals(done.body, { ok: true, written: ['providers/house.ts'] });
          const written = Deno.readTextFileSync(join(studio.root, 'providers/house.ts'));
          assert(!/[^\r]\n/.test(written), 'a line lost its carriage return');
          assert(written.includes('\t\t\tbaseUrl: "https://changed.example/v1",\r\n'), written);
          // The comment above the address stays where the builder wrote it.
          assert(written.includes('\t\t\t// where the gateway listens\r\n'), written);
          assert(written.includes('\t\tkeySlot: "changed_key",\r\n'), written);
          // A setting the file did not hold is written in its tabs, quotes, and line endings.
          assert(written.includes('\t\tfallbackKeySlot: "changed_spare",\r\n'), written);
          const reopened = await open(studio);
          const house = reopened.workspace.providers.find((provider) => provider.id === 'house');
          assertEquals(house, {
            id: 'house',
            definition: 'local',
            connection: { baseUrl: 'https://changed.example/v1' },
            keySlot: 'changed_key',
            fallbackKeySlot: 'changed_spare',
          });
          assertEquals(
            reopened.modelProblems?.filter((problem) => problem.profile === 'desk') ?? [],
            [],
          );
          assertEquals((await studio.post(`${SAVE}/undo`, {})).body, {
            ok: true,
            written: ['providers/house.ts'],
          });
          assertSameFiles(snapshot(studio.root), original);
          assertEquals((await studio.post<SaveRefusal>(`${SAVE}/undo`, {})).body.reason, 'nothing');
          opened = await open(studio);
        },
      );

      await step('a provider made by a function is not written into the function', async () => {
        const workspace = withProvider(
          opened.workspace,
          'made-a',
          atBase('https://changed.example/v1'),
        );
        const review = await studio.post<SaveReview>(SAVE, { workspace });
        assertEquals(review.body.writable, false);
        const done = await studio.post<SaveRefusal>(SAVE, { workspace, stamp: review.body.stamp });
        assertEquals(done.body.ok, false);
        assertSameFiles(snapshot(studio.root), original);
      });

      await step(
        'a forged, replayed, or raced stamp writes nothing it did not review',
        async () => {
          const first = renamed(opened.workspace, 'First');
          const second = renamed(opened.workspace, 'Second');
          const forged = await studio.post<SaveRefusal>(SAVE, {
            workspace: first,
            stamp: '0'.repeat(64),
          });
          assertEquals(forged.body.reason, 'stale');
          const firstReview = (await studio.post<SaveReview>(SAVE, { workspace: first })).body;
          const secondReview = (await studio.post<SaveReview>(SAVE, { workspace: second })).body;
          // The second's stamp, sent with the first's workspace: what is written must be what was read.
          const swapped = await studio.post<SaveRefusal>(SAVE, {
            workspace: first,
            stamp: secondReview.stamp,
          });
          assertEquals(swapped.body.reason, 'stale');
          assertSameFiles(snapshot(studio.root), original);
          // Both stamps were read from the same files, so exactly one of the two raced writes lands.
          // Which one is the server's order, not the order the requests were sent in.
          const contenders = [
            { handle: 'First', workspace: first, stamp: firstReview.stamp },
            { handle: 'Second', workspace: second, stamp: secondReview.stamp },
          ];
          const raced = await Promise.all(
            contenders.map(({ workspace, stamp }) =>
              studio.post<SaveDone | SaveRefusal>(SAVE, { workspace, stamp }),
            ),
          );
          const landed = raced.map((reply) => reply.body.ok);
          assertEquals(
            landed.filter(Boolean).length,
            1,
            JSON.stringify(raced.map((reply) => reply.body)),
          );
          const winner = contenders[landed.indexOf(true)];
          const loser = raced[landed.indexOf(false)];
          assert(winner && loser);
          assertEquals((loser.body as SaveRefusal).reason, 'stale');
          const afterWin = snapshot(studio.root);
          assert(
            new TextDecoder()
              .decode(afterWin.get('agents/desk.ts'))
              .includes(`handle: '${winner.handle}'`),
          );
          const replay = await studio.post<SaveRefusal>(SAVE, {
            workspace: winner.workspace,
            stamp: winner.stamp,
          });
          assertEquals(replay.body.ok, false);
          assertSameFiles(snapshot(studio.root), afterWin);
          assertEquals((await studio.post(`${SAVE}/undo`, {})).body, {
            ok: true,
            written: ['agents/desk.ts'],
          });
          assertSameFiles(snapshot(studio.root), original);
          opened = await open(studio);
        },
      );

      await step(
        "the builder's editor, writing between the review and the write, wins",
        async () => {
          const desk = join(studio.root, 'agents/desk.ts');
          const workspace = renamed(opened.workspace, 'Studio');
          const review = (await studio.post<SaveReview>(SAVE, { workspace })).body;
          const theirs = `${Deno.readTextFileSync(desk)}// the builder typed this\n`;
          Deno.writeTextFileSync(desk, theirs);
          const done = await studio.post<SaveRefusal>(SAVE, { workspace, stamp: review.stamp });
          assertEquals(done.body.reason, 'stale');
          assertEquals(Deno.readTextFileSync(desk), theirs);
          // Saved, then the editor writes: undo leaves the editor's file alone.
          Deno.writeFileSync(desk, bytesOf('agents/desk.ts'));
          opened = await open(studio);
          const again = (
            await studio.post<SaveReview>(SAVE, { workspace: renamed(opened.workspace, 'Studio') })
          ).body;
          assertEquals(
            (
              await studio.post(SAVE, {
                workspace: renamed(opened.workspace, 'Studio'),
                stamp: again.stamp,
              })
            ).body,
            {
              ok: true,
              written: ['agents/desk.ts'],
            },
          );
          const saved = Deno.readTextFileSync(desk);
          Deno.writeTextFileSync(desk, `${saved}// and this\n`);
          const undone = await studio.post<SaveRefusal>(`${SAVE}/undo`, {});
          assertEquals([undone.body.reason, undone.body.detail], ['stale', ['agents/desk.ts']]);
          assertEquals(Deno.readTextFileSync(desk), `${saved}// and this\n`);
          Deno.writeFileSync(desk, bytesOf('agents/desk.ts'));
          opened = await open(studio);
          assertSameFiles(snapshot(studio.root), original);
        },
      );

      await step(
        'a link in the project, to a file or a folder outside it, is never written through',
        async () => {
          const desk = join(studio.root, 'agents/desk.ts');
          const away = join(studio.base, 'desk-away.ts');
          Deno.writeFileSync(away, bytesOf('agents/desk.ts'));
          Deno.removeSync(desk);
          Deno.symlinkSync(away, desk);
          const providers = join(studio.root, 'providers');
          const awayFolder = join(studio.base, 'providers-away');
          Deno.renameSync(providers, awayFolder);
          Deno.symlinkSync(awayFolder, providers);
          const awayBefore = [
            Deno.readFileSync(away),
            snapshot(awayFolder),
            Deno.readFileSync(studio.outside),
          ] as const;
          try {
            const current = await open(studio);
            for (const workspace of [
              renamed(current.workspace, 'Linked'),
              withProvider(current.workspace, 'house', atBase('https://linked.example/v1')),
              withProvider(current.workspace, 'left', atBase('https://linked.example/v1')),
            ]) {
              const review = await studio.post<SaveReview | SaveRefusal>(SAVE, { workspace });
              const stamp = review.body.ok ? review.body.stamp : undefined;
              const done = await studio.post<SaveDone | SaveRefusal>(SAVE, { workspace, stamp });
              assertEquals(done.body.ok, false, JSON.stringify([review.body, done.body]));
            }
            assertEquals(Deno.readFileSync(away), awayBefore[0]);
            assertSameFiles(snapshot(awayFolder), awayBefore[1]);
            assertEquals(Deno.readFileSync(studio.outside), awayBefore[2]);
          } finally {
            Deno.removeSync(desk);
            Deno.writeFileSync(desk, bytesOf('agents/desk.ts'));
            Deno.removeSync(providers);
            Deno.renameSync(awayFolder, providers);
            Deno.removeSync(away);
          }
          opened = await open(studio);
          assertSameFiles(snapshot(studio.root), original);
        },
      );

      await step(
        'the editor opens project files only, and only with an editor the studio lists',
        async () => {
          for (const file of [
            '../outside.txt',
            studio.outside,
            'agents/../../outside.txt',
            '/etc/passwd',
            'deno.json',
            'agents',
            '',
          ]) {
            const answer = await studio.post<{ ok: boolean; reason?: string }>('/api/studio/open', {
              file,
              line: 1,
            });
            assertEquals(
              [answer.status, answer.body.ok, answer.body.reason],
              [200, false, 'file'],
              file,
            );
          }
          for (const editor of ['code; touch /tmp/x', '/bin/sh', 'sh -c id', '../code']) {
            assertEquals(
              (await studio.post('/api/studio/open', { file: SETUP, editor })).status,
              400,
              editor,
            );
          }
          assertEquals(studio.opened(), '');
          const answer = await studio.post<{ ok: boolean }>('/api/studio/open', {
            file: 'providers/house.ts',
            line: 8,
          });
          assertEquals(answer.body.ok, true);
          for (let waited = 0; studio.opened() === '' && waited < 5000; waited += 50)
            await new Promise((settle) => setTimeout(settle, 50));
          assertEquals(studio.opened(), `-g ${join(studio.root, 'providers/house.ts')}:8\n`);
        },
      );

      await step(
        'one save changes a tool in tabs, a tool held in a constant, and two profiles in one file',
        async () => {
          const lookup = 'Finds a city by its name.';
          const wipe = 'Clears the desk, every note on it.';
          let workspace = withTool(opened.workspace, 'lookup_city', (tool) => ({
            ...tool,
            description: lookup,
          }));
          workspace = withTool(workspace, 'wipe_desk', (tool) => ({ ...tool, description: wipe }));
          workspace = setToolAllowed(
            workspace,
            agentKey(workspace, 'concierge'),
            toolKey(workspace, 'wipe_desk'),
            true,
          );
          workspace = withAgent(workspace, 'triage', (agent) => ({
            ...agent,
            decision: { ...agent.decision, contract: 'triage.v2' },
          }));
          const written = await saved(studio, workspace);
          assertEquals([...written].sort(), ['agents/team.ts', 'tools/danger.ts', 'tools/kit.ts']);
          const kit = Deno.readTextFileSync(join(studio.root, 'tools/kit.ts'));
          assert(!/^ +\S/m.test(kit), `a tab became spaces:\n${kit}`);
          const reopened = (await open(studio)).workspace;
          assertEquals(
            reopened.toolSpecs.find((tool) => tool.toolName === 'lookup_city')?.description,
            lookup,
          );
          assertEquals(
            reopened.toolSpecs.find((tool) => tool.toolName === 'wipe_desk')?.description,
            wipe,
          );
          const concierge = reopened.agents.find((agent) => agent.identity.agentId === 'concierge');
          assert(concierge?.tools.allow.includes(toolKey(reopened, 'wipe_desk')));
          assertEquals(
            reopened.agents.find((agent) => agent.identity.agentId === 'triage')?.decision.contract,
            'triage.v2',
          );
          await undone(studio, written, original);
          opened = await open(studio);
        },
      );

      await step(
        'a constant two tools share is written only when both change it the same way',
        async () => {
          const confirm = (tool: Tool): Tool => ({ ...tool, permission: 'always_confirm' });
          const one = withTool(opened.workspace, 'lookup_city', confirm);
          const review = (await studio.post<SaveReview>(SAVE, { workspace: one })).body;
          const change = review.changes.find((candidate) => candidate.of === 'lookup_city');
          assertEquals(
            [change?.status, change?.name, change?.sharedWith, review.writable],
            ['constant', 'READ', ['fetch_rates'], false],
          );
          assertEquals(
            (await studio.post<SaveRefusal>(SAVE, { workspace: one, stamp: review.stamp })).body.ok,
            false,
          );
          assertSameFiles(snapshot(studio.root), original);
          const both = withTool(one, 'fetch_rates', confirm);
          assertEquals(await saved(studio, both), ['tools/kit.ts']);
          const kit = Deno.readTextFileSync(join(studio.root, 'tools/kit.ts'));
          assertEquals(kit.match(/always_confirm/g)?.length, 1, kit);
          const reopened = (await open(studio)).workspace;
          assertEquals(
            reopened.toolSpecs
              .filter((tool) => tool.permission === 'always_confirm')
              .map((tool) => tool.toolName)
              .sort(),
            ['fetch_rates', 'lookup_city', 'wipe_desk'],
          );
          await undone(studio, ['tools/kit.ts'], original);
          opened = await open(studio);
        },
      );

      await step(
        'a tool taken away is gone from the project and from every agent, and undo brings it back',
        async () => {
          const written = await saved(
            studio,
            removeLibraryTool(opened.workspace, toolKey(opened.workspace, 'wipe_desk')),
          );
          assertEquals([...written].sort(), ['agents/team.ts', 'app.ts', 'tools/danger.ts']);
          const app = Deno.readTextFileSync(join(studio.root, 'app.ts'));
          assert(!app.includes('wipe'), app);
          assertEquals(snapshot(studio.root).has('tools/danger.ts'), false);
          const reopened = await open(studio);
          assertEquals(
            reopened.workspace.toolSpecs.map((tool) => tool.toolName),
            ['lookup_city', 'fetch_rates'],
          );
          assertEquals([reopened.problems, reopened.unregistered], [[], []]);
          const call = await studio.call(
            '/api/studio/profiles/gatekeeper/call',
            post({ name: 'wipe_desk', input: { confirm: true } }),
          );
          assert(!(await call.text()).includes('"phase":"complete"'));
          await undone(studio, written, original);
          opened = await open(studio);
          assertEquals(opened.workspace.toolSpecs.length, 3);
        },
      );

      await step(
        'a save the project no longer type-checks or loads with is taken back, and the editor keeps its file',
        async () => {
          const model = join(studio.root, 'model.ts');
          for (const [broken, reason] of [
            ["\nexport const broken: number = 'not a number';\n", 'check'],
            ["\nthrow new Error('the setup cannot load');\n", 'load'],
          ] as const) {
            const theirs = `${Deno.readTextFileSync(model)}${broken}`;
            Deno.writeTextFileSync(model, theirs);
            try {
              const workspace = renamed(opened.workspace, 'Broken');
              const review = (await studio.post<SaveReview>(SAVE, { workspace })).body;
              assert(review.writable, JSON.stringify(review));
              const done = await studio.post<SaveRefusal>(SAVE, { workspace, stamp: review.stamp });
              assertEquals(done.body.reason, reason, JSON.stringify(done.body));
              assertEquals(
                Deno.readFileSync(join(studio.root, 'agents/desk.ts')),
                original.get('agents/desk.ts'),
              );
              assertEquals(Deno.readTextFileSync(model), theirs);
              assertEquals(
                (await studio.post<SaveRefusal>(`${SAVE}/undo`, {})).body.reason,
                'nothing',
              );
            } finally {
              Deno.writeFileSync(model, bytesOf('model.ts'));
            }
          }
          opened = await open(studio);
          assertSameFiles(snapshot(studio.root), original);
        },
      );

      await step(
        'the editor writing while Save checks its write: Save takes back its own, and leaves the editor its file',
        async () => {
          const desk = join(studio.root, 'agents/desk.ts');
          const workspace = renamed(opened.workspace, 'Midway');
          const review = (await studio.post<SaveReview>(SAVE, { workspace })).body;
          const saving = studio.post<SaveDone | SaveRefusal>(SAVE, {
            workspace,
            stamp: review.stamp,
          });
          const before = bytesOf('agents/desk.ts');
          for (let waited = 0; waited < 20_000; waited += 5) {
            if (!Deno.readFileSync(desk).every((byte, at) => byte === before[at])) break;
            await new Promise((settle) => setTimeout(settle, 5));
          }
          const theirs = `${new TextDecoder().decode(before)}// the builder's own\n`;
          Deno.writeTextFileSync(desk, theirs);
          const done = (await saving).body;
          assert(!done.ok, JSON.stringify(done));
          assert(done.kept?.includes('agents/desk.ts'), JSON.stringify(done));
          assertEquals(Deno.readTextFileSync(desk), theirs);
          Deno.writeFileSync(desk, before);
          opened = await open(studio);
          assertSameFiles(snapshot(studio.root), original);
        },
      );

      await step(
        "the page hears when the builder's editor writes a file the setup reads",
        async () => {
          const response = await studio.call('/api/studio/watch');
          assertEquals(response.status, 200);
          assert(response.body);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let heard = '';
          const until = async (seen: (text: string) => boolean) => {
            const deadline = Date.now() + 10_000;
            while (!seen(heard)) {
              const next = await Promise.race([
                reader.read(),
                new Promise<undefined>((settle) =>
                  setTimeout(settle, Math.max(0, deadline - Date.now())),
                ),
              ]);
              if (!next || next.done) throw new Error(`The feed said only:\n${heard}`);
              heard += next.value;
            }
          };
          const pair = join(studio.root, 'providers/pair.ts');
          try {
            await until((text) => text.includes(': watching'));
            Deno.writeTextFileSync(pair, `${Deno.readTextFileSync(pair)}// touched\n`);
            await until((text) => text.includes('data: '));
            const files: string[] = JSON.parse(
              heard.slice(heard.indexOf('data: ') + 6).split('\n')[0] ?? '',
            ).files;
            assert(
              files.some((file) => file.endsWith('providers/pair.ts')),
              heard,
            );
          } finally {
            await reader.cancel();
            Deno.writeFileSync(pair, bytesOf('providers/pair.ts'));
          }
          opened = await open(studio);
          assertSameFiles(snapshot(studio.root), original);
        },
      );

      await step(
        'the edited load runs the unsaved edits, and nothing answers for it before one starts',
        async () => {
          const before = await studio.call('/api/studio/edited/profiles/desk');
          await before.body?.cancel();
          assertEquals(before.status, 409);
          const workspace = withProvider(
            renamed(opened.workspace, 'Unsaved'),
            'left',
            atBase('https://unsaved.example/v1'),
          );
          const started = await studio.post<{ ok: boolean; stamp?: string; saved: string[] }>(
            '/api/studio/edited',
            { workspace },
          );
          assertEquals(
            [started.body.ok, started.body.saved],
            [true, ['desk', 'concierge', 'gatekeeper', 'triage']],
          );
          const edited = await (await studio.call('/api/studio/edited/profiles/desk')).json();
          const saved = await (await studio.call('/api/studio/profiles/desk')).json();
          assertEquals(
            [edited.interface?.identity?.handle, saved.interface?.identity?.handle],
            ['Unsaved', 'Desk'],
          );
          const turn = await lines(
            studio,
            '/api/studio/edited/profiles/desk/turn',
            ask('Where is Lisbon?'),
          );
          assert(replyOf(turn).startsWith('Found:'), JSON.stringify(turn));
          assertSameFiles(snapshot(studio.root), original);
          assertEquals((await open(studio)).workspace.agents[0]?.identity.handle, 'Desk');
        },
      );
    } finally {
      await studio.close();
    }
    assertEquals(await running(studio.base), false, 'a process the studio started outlived it');
    Deno.removeSync(studio.base, { recursive: true });
  },
);
