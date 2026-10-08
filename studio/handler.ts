/**
 * The studio's local server: what a project registered, and its tools to call.
 * The page reads the tree from `GET <base>` and runs a tool through the host
 * console mounted at `<base>/host`.
 *
 * First slice (docs/proposals/theorem-studio.md, section 4.4). It reads and
 * runs; it writes nothing to the project.
 *
 * @module
 */

import { listProfiles, listTools, type Profile } from '../mod.ts';
import { createTheoremHostHandler } from '../react/src/server/mod.ts';

/** The profile the studio serves every tool through. A project never sees it. */
const STUDIO_HOST_ID = 'theorem-studio';
/** One builder on one machine: every request is the same session, so a gate's answer finds its call. */
const STUDIO_SESSION = 'theorem-studio-local';
const CALLABLE = ['function', 'http', 'mcp'] as const;
type CallableKind = (typeof CALLABLE)[number];

export type StudioProfileView = {
  id: string;
  type: Profile['type'];
  handle?: string;
  /** The tools the profile allows, in its order. */
  tools: string[];
};

export type StudioToolView = {
  name: string;
  description: string;
  kind: CallableKind;
  access: string;
  /** The profiles that allow the tool. */
  usedBy: string[];
};

/** What the tree is drawn from. */
export type StudioDescription = {
  project: string;
  profiles: StudioProfileView[];
  tools: StudioToolView[];
};

export type StudioHandlerOptions = {
  /** The project's name, shown at the top of the page. */
  project: string;
  /** The one origin whose page may call the server. Any other origin is refused. */
  pageOrigin: string;
  /** The `host:port` the server listens on. A request that names another host is refused. */
  listenHost: string;
  /** Opaque application context for tool handlers (`ctx.host`): the test user, a database client. */
  host?: (request: Request) => unknown;
  /** Where the handler is mounted. Default `/api/studio`. */
  base?: string;
};

function isCallable(type: string): type is CallableKind {
  return (CALLABLE as readonly string[]).includes(type);
}

function allowedTools(profile: Profile): string[] {
  const tools = (profile as { tools?: { allow?: readonly string[] } }).tools;
  return [...(tools?.allow ?? [])];
}

function handleOf(profile: Profile): string | undefined {
  return (profile as { identity?: { handle?: string } }).identity?.handle;
}

/** The registered profiles and tools, as the tree shows them. */
export function describeStudio(project: string): StudioDescription {
  const profiles = listProfiles()
    .filter((profile) => profile.id !== STUDIO_HOST_ID)
    .map((profile) => {
      const handle = handleOf(profile);
      return {
        id: profile.id,
        type: profile.type,
        ...(handle ? { handle } : {}),
        tools: allowedTools(profile),
      };
    });
  const tools = listTools().flatMap((tool) =>
    isCallable(tool.type)
      ? [
          {
            name: tool.name,
            description: tool.description,
            kind: tool.type,
            access: tool.access,
            usedBy: profiles.filter((p) => p.tools.includes(tool.name)).map((p) => p.id),
          },
        ]
      : [],
  );
  return { project, profiles, tools };
}

function json(status: number, body: unknown, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Serves the studio for the tools and profiles registered when it is called.
 * Register the project first.
 */
export function createStudioHandler(
  options: StudioHandlerOptions,
): (request: Request) => Promise<Response> {
  const base = (options.base ?? '/api/studio').replace(/\/$/, '');
  const cors = {
    'access-control-allow-origin': options.pageOrigin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
  const allow = listTools()
    .filter((tool) => isCallable(tool.type))
    .map((tool) => tool.name);
  const console_ =
    allow.length > 0
      ? createTheoremHostHandler({
          profile: { type: 'host', id: STUDIO_HOST_ID, tools: { allow } },
          session: () => STUDIO_SESSION,
          ...(options.host ? { host: options.host } : {}),
        })
      : undefined;

  return async (request) => {
    const url = new URL(request.url);
    // why: a page on another site can reach 127.0.0.1 through the builder's browser. The origin
    // check stops its requests; the host check stops a name it pointed at this machine.
    if (request.headers.get('host') !== options.listenHost) return json(403, {}, {});
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== options.pageOrigin) return json(403, {}, {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === base && request.method === 'GET') {
      return json(200, describeStudio(options.project), cors);
    }
    if (console_ && (url.pathname === `${base}/host` || url.pathname.startsWith(`${base}/host/`))) {
      const response = await console_(request);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(cors)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }
    return json(404, {}, cors);
  };
}
