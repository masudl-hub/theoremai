/**
 * The studio's local server: a project's registered profiles and tools, as the
 * studio's workspace, and each profile served to run.
 *
 * The page is the studio. It reads its workspace from `GET <base>` and runs
 * the open profile at `<base>/profiles/<id>`, so a run is the project's own
 * code, not the page's draft.
 *
 * It reads and runs. Writing an edit back to the project is the server's
 * (`serve.ts`), which starts this in a process of its own and starts it again
 * after a Save, so a run is always the code on disk.
 *
 * @module
 */

import { listProfiles, listTools, type Profile, type ProviderHostOptions, registerTool } from '../../mod.ts';
import { type StudioAsks, studioAsks } from '../asks.ts';
import { createBlankDraft, type StudioDraft, type ToolSpecDraft } from '../draft.ts';
import { readStudioSource } from '../read-source.ts';
import type { ToolRegistration } from '../registrations.ts';
import { studioSource } from '../source.ts';
import type { ProjectOrigins, SharedSetting } from './save-wire.ts';
import {
  addAgent,
  agentNodeId,
  createBlankWorkspace,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../workspace.ts';
import { createTheoremHandler, createTheoremHostHandler } from '../../react/src/server/mod.ts';

/** One builder on one machine: every request is the same session, so a gate's answer finds its call. */
const STUDIO_SESSION = 'theorem-studio-local';

/** A profile the page could not show or run, and why. */
export type StudioProblem = { profile: string; message: string };

/** What the page opens. */
export type StudioDescription = {
  project: string;
  /** The project as the studio holds one: an agent per profile, and the tools they share. */
  workspace: StudioWorkspace;
  problems: StudioProblem[];
  /** The settings several profiles share. The studio command reads them from the project's files. */
  shared?: SharedSetting[];
  /** The settings the project's files set in code, which the studio shows and does not change. */
  origins?: ProjectOrigins;
  /** The tools that write: the ones the studio makes ask before each run, and the ones it cannot. */
  asks: StudioAsks;
};

export type StudioHandlerOptions = {
  /** The project's name, shown at the top of the page. */
  project: string;
  /** The origins whose page may call the server. Any other origin is refused. */
  pageOrigins: readonly string[];
  /** The `host:port` the server listens on. A request that names another host is refused. */
  listenHost: string;
  /** Opaque application context for tool handlers (`ctx.host`): the test user, a database client. */
  host?: (request: Request) => unknown;
  /** How the project's registered providers find their keys. Default: as the project registered them. */
  provider?: ProviderHostOptions;
  /** Where the handler is mounted. Default `/api/studio`. */
  base?: string;
};

type Serve = (request: Request) => Promise<Response>;

/** The registered tools as the studio's printer takes them: their fields and JSON schemas. */
function registeredTools(): ToolRegistration[] {
  return listTools().map((tool) => {
    const fields: Record<string, unknown> = { ...tool };
    for (const own of ['handler', 'input', 'output']) delete fields[own];
    return fields as ToolRegistration;
  });
}

type ProfileRead =
  | { ok: true; draft: StudioDraft; registered: ToolSpecDraft[] }
  | { ok: false; message: string };

/** One registered profile as the draft the editor shows, read from the source the studio prints for it. */
function readProfile(profile: Profile, tools: readonly ToolRegistration[]): ProfileRead {
  try {
    const source = studioSource({
      agentId: profile.id,
      profile: profile as Parameters<typeof studioSource>[0]['profile'],
      customTools: [...tools],
    });
    const read = readStudioSource(source, createBlankDraft());
    if (!read.ok) return { ok: false, message: read.errors.map((error) => error.message).join(' ') };
    return { ok: true, draft: read.draft, registered: read.registered };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The tools of `registered` the workspace does not hold yet, by name. */
function unlisted(workspace: StudioWorkspace, registered: ToolSpecDraft[]): ToolSpecDraft[] {
  const held = new Set(workspace.toolSpecs.map((tool) => tool.toolName));
  return registered.filter((tool) => !held.has(tool.toolName));
}

/** The registered profiles and tools, as the workspace the studio opens. */
function describeStudio(project: string): StudioDescription {
  const tools = registeredTools();
  const problems: StudioProblem[] = [];
  let workspace: StudioWorkspace | undefined;
  let library: ToolSpecDraft[] = [];
  for (const profile of listProfiles()) {
    const read = readProfile(profile, tools);
    if (!read.ok) {
      problems.push({ profile: profile.id, message: read.message });
      continue;
    }
    workspace = workspace ? addAgent(workspace, read.draft) : workspaceFromDraft(read.draft);
    library = read.registered;
  }
  const opened = workspace ?? createBlankWorkspace();
  // A tool no profile allows is still the project's: it joins the library.
  const extra = unlisted(opened, library);
  const first = opened.agents[0];
  return {
    project,
    workspace: {
      ...opened,
      toolSpecs: [...opened.toolSpecs, ...extra],
      starts: {
        ...opened.starts,
        tools: { ...opened.starts.tools, ...Object.fromEntries(extra.map((t) => [t.key, t])) },
      },
      ...(first ? { selected: agentNodeId(first.key), chatWith: first.key } : {}),
    },
    problems,
    asks: { asked: [], inside: [] },
  };
}

/**
 * Makes every registered tool that writes ask the builder before each run, whatever its own
 * setting: a run in the studio is the project's real code, on whatever it reaches. The project's
 * files are not touched, and the editor shows what they say.
 */
function askBeforeWrites(): StudioAsks {
  const tools = listTools();
  const profiles = new Map(listProfiles().map((profile) => [profile.id as string, profile]));
  const asks = studioAsks(tools, (id) => {
    const profile = profiles.get(id);
    return profile && 'tools' in profile ? profile.tools.allow : [];
  });
  for (const tool of tools) {
    if (asks.asked.includes(tool.name)) registerTool({ ...tool, permission: 'always_confirm' });
  }
  return asks;
}

export function json(status: number, body: unknown, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Whether a request comes from somewhere other than the studio's own page.
 * A page on another site can reach 127.0.0.1 through the builder's browser: the
 * origin check stops its requests, and the host check stops a name it pointed at
 * this machine.
 */
export function isForeign(
  request: Request,
  options: Pick<StudioHandlerOptions, 'listenHost' | 'pageOrigins'>,
): boolean {
  if (request.headers.get('host') !== options.listenHost) return true;
  const origin = request.headers.get('origin');
  return origin !== null && !options.pageOrigins.includes(origin);
}

/** Where the server is mounted unless the host says otherwise. */
export const STUDIO_BASE = '/api/studio';

/** The page's own origin, echoed: a request from any other was refused before this. */
export function corsHeaders(request: Request, pageOrigins: readonly string[]): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers.get('origin') ?? pageOrigins[0] ?? '',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}

/** Each registered profile's own handler, by id; a profile that cannot be served is a problem. */
function profileHandlers(options: StudioHandlerOptions, problems: StudioProblem[]): Map<string, Serve> {
  const served = new Map<string, Serve>();
  const shared = {
    session: () => STUDIO_SESSION,
    ...(options.host ? { host: options.host } : {}),
  };
  for (const profile of listProfiles()) {
    if (profile.type === 'decision') continue;
    try {
      served.set(
        profile.id,
        profile.type === 'host'
          ? createTheoremHostHandler({ profile, ...shared })
          : createTheoremHandler({ profile, provider: options.provider ?? {}, ...shared }),
      );
    } catch (error) {
      problems.push({
        profile: profile.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return served;
}

/**
 * Serves the studio for the tools and profiles registered when it is called.
 * Register the project first.
 */
export function createStudioHandler(
  options: StudioHandlerOptions,
): (request: Request) => Promise<Response> {
  const base = (options.base ?? STUDIO_BASE).replace(/\/$/, '');
  const corsFor = (request: Request) => corsHeaders(request, options.pageOrigins);
  // The page reads the tools as the files set them, then they are made to ask.
  const description = describeStudio(options.project);
  description.asks = askBeforeWrites();
  const served = profileHandlers(options, description.problems);
  const prefix = `${base}/profiles/`;

  const run = async (request: Request, path: string): Promise<Response> => {
    const cors = corsFor(request);
    const id = decodeURIComponent(path.slice(prefix.length).split('/')[0] ?? '');
    const serve = served.get(id);
    if (!serve) return json(404, {}, cors);
    const response = await serve(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  };

  const answer = (request: Request): Response | Promise<Response> => {
    if (isForeign(request, options)) return json(403, {}, {});
    const cors = corsFor(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(request.url).pathname;
    if (path === base && request.method === 'GET') return json(200, description, cors);
    if (path.startsWith(prefix)) return run(request, path);
    return json(404, {}, cors);
  };
  return (request) => Promise.resolve(answer(request));
}
