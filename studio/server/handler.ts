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

import {
  type DecisionQuestion,
  getProvider,
  getStructured,
  listProfiles,
  listTools,
  type Profile,
  type ProviderHostOptions,
  registerTool,
} from '../../mod.ts';
import { type StudioAsks, studioAsks } from '../asks.ts';
import { createBlankDraft, type StudioDraft, type ToolSpecDraft } from '../draft.ts';
import { STUDIO_TRACE_DESTINATION } from '../policy.ts';
import { readStudioSource } from '../read-source.ts';
import type { ToolRegistration } from '../registrations.ts';
import { studioSource } from '../source.ts';
import { createStudioLiveHandler, type StudioUpgrade } from './live.ts';
import { tracedToPage, withRunTraces } from './run-traces.ts';
import type { ProjectOrigins, SharedSetting } from './save-wire.ts';
import {
  addAgent,
  agentNodeId,
  createBlankWorkspace,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../workspace.ts';
import {
  createTheoremDecisionHandler,
  createTheoremHandler,
  createTheoremHostHandler,
} from '../../react/src/server/mod.ts';

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
  /** What the project printed when its files stopped loading. The page then shows the last load that did. */
  unloaded?: string;
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
  /** What each decision profile asks, by the profile's id: the questions the application passes when it decides. */
  questions?: ProjectQuestions;
  /** How the server takes a socket, which a voice call needs. Without it a live profile is not run. */
  upgrade?: StudioUpgrade;
  /** Where the handler is mounted. Default `/api/studio`. */
  base?: string;
};

/** A project's decision questions: for each decision profile's id, its questions by their ids. */
export type ProjectQuestions = Record<string, Record<string, DecisionQuestion>>;

type Serve = (request: Request) => Promise<Response>;

/** The registered tools as the studio's printer takes them: their fields and JSON schemas. */
function registeredTools(): ToolRegistration[] {
  return listTools()
    // A provider's built-in tool is a model's setting, not a tool the project registers.
    .filter((tool) => tool.type !== 'builtin')
    .map((tool) => {
      const fields: Record<string, unknown> = { ...tool };
      for (const own of ['handler', 'input', 'output']) delete fields[own];
      // What the file writes as code (a hook before the call, its sources) is left to the file.
      return plainSetting(fields) as ToolRegistration;
    });
}

type ProfileRead =
  | { ok: true; draft: StudioDraft; registered: ToolSpecDraft[] }
  | { ok: false; message: string };

/** The key slots a provider or a model names. */
type ProviderSlots = { keySlot?: string; fallbackKeySlot?: string };

/**
 * A profile with the key slots the kernel runs its models with: a model that names no slot uses
 * the one its provider was registered with.
 */
export function withProviderSlots<P extends object>(
  profile: P,
  providerOf: (
    id: string,
  ) => Pick<NonNullable<ReturnType<typeof getProvider>>, 'keySlot' | 'fallbackKeySlot'> | undefined = getProvider,
): P {
  const held = (profile as { models?: Record<string, ProviderSlots & { provider?: string }> }).models;
  if (!held || typeof held !== 'object') return profile;
  const models = Object.entries(held)
    .map(([name, model]) => {
      const provider = model.provider ? providerOf(model.provider) : undefined;
      const keySlot = model.keySlot ?? provider?.keySlot;
      const fallbackKeySlot = model.fallbackKeySlot ?? provider?.fallbackKeySlot;
      return [name, { ...model, ...(keySlot ? { keySlot } : {}), ...(fallbackKeySlot ? { fallbackKeySlot } : {}) }];
    });
  return { ...profile, models: Object.fromEntries(models) };
}

/** A setting with what only code can say taken out, or nothing when it is code itself. */
function plainSetting(value: unknown): unknown {
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(plainSetting).filter((item) => item !== undefined);
  if (!isRecord(value)) return value;
  const kept = Object.entries(value)
    .map(([key, item]) => [key, plainSetting(item)] as const)
    .filter(([, item]) => item !== undefined);
  // A setting that was all code is left out whole, not shown as an empty one.
  return kept.length || !Object.keys(value).length ? Object.fromEntries(kept) : undefined;
}

/**
 * A profile as the studio can print it. What a file writes as code (a validator, a trigger, a
 * trace sink of its own) cannot be shown as a setting, so it is left to the file: the editor
 * says where it is set, Save does not touch it, and a run is still the profile as registered.
 */
export function printableProfile<P extends Profile>(profile: P): P {
  const { observability } = profile;
  // A sink of the project's own still records, so the studio shows the profile as one that does.
  const recording = isRecord(observability?.writeTo)
    ? { ...profile, observability: { ...observability, writeTo: STUDIO_TRACE_DESTINATION } }
    : profile;
  return plainSetting(recording) as P;
}

/**
 * The schema a profile's replies take, as registered. None when the profile names one nothing
 * registers, or one for each slot: the editor holds a single schema.
 */
function replySchema(profile: Profile) {
  const id = 'outputs' in profile ? profile.outputs?.structured : undefined;
  if (typeof id !== 'string') return undefined;
  try {
    return { id, spec: { jsonSchema: getStructured(id).jsonSchema } };
  } catch {
    return undefined;
  }
}

/** One registered profile as the draft the editor shows, read from the source the studio prints for it. */
function readProfile(
  profile: Profile,
  tools: readonly ToolRegistration[],
  questions: Record<string, DecisionQuestion> | undefined,
): ProfileRead {
  try {
    const structured = replySchema(profile);
    const source = studioSource({
      ...(questions ? { questions } : {}),
      agentId: profile.id,
      profile: withProviderSlots(printableProfile(profile)) as Parameters<typeof studioSource>[0]['profile'],
      customTools: [...tools],
      ...(structured ? { structured } : {}),
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
function describeStudio(project: string, questions: ProjectQuestions): StudioDescription {
  const tools = registeredTools();
  const problems: StudioProblem[] = [];
  let workspace: StudioWorkspace | undefined;
  let library: ToolSpecDraft[] = [];
  for (const profile of listProfiles()) {
    const asked = questions[profile.id];
    // A decision the studio cannot ask is left out, with why: a draft with no questions would not compile.
    const fault = profile.type === 'decision' ? questionsFault(profile.id, asked) : undefined;
    if (fault) {
      problems.push({ profile: profile.id, message: fault });
      continue;
    }
    const read = readProfile(profile, tools, asked);
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
  // A tool that runs an agent names it by id. Each profile is read alone, so the agent is found once all are.
  const runs = new Map(tools.flatMap((tool) => (tool.type === 'agent' ? [[tool.name, tool.profile] as const] : [])));
  const linked = (tool: ToolSpecDraft): ToolSpecDraft => {
    const id = tool.toolType === 'agent' && !tool.agentKey ? runs.get(tool.toolName) : undefined;
    const agentKey = id && opened.agents.find((agent) => agent.identity.agentId === id)?.key;
    return agentKey ? { ...tool, agentKey } : tool;
  };
  const toolSpecs = [...opened.toolSpecs, ...extra].map(linked);
  return {
    project,
    workspace: {
      ...opened,
      toolSpecs,
      starts: { ...opened.starts, tools: Object.fromEntries(toolSpecs.map((tool) => [tool.key, tool])) },
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

/** Why a decision profile is not run: the setup file does not name its questions. */
export function noQuestions(profileId: string): string {
  return `The studio does not know what ${profileId} asks. Export the questions your application passes it from the setup file: export const questions = { '${profileId}': { ... } }.`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What each kind of question needs of its criteria, and what is wrong when it lacks it. */
const CRITERIA = new Map<unknown, { fits: (criteria: unknown) => boolean; fault: string }>([
  ['choice', {
    fits: (criteria) => isRecord(criteria) && Object.keys(criteria).length > 0,
    fault: 'needs criteria: an object of the labels it picks from',
  }],
  ['score', {
    fits: (criteria) => Array.isArray(criteria) && criteria.length > 0,
    fault: 'needs criteria: a list, lowest score first',
  }],
  ['noul', {
    fits: (criteria) => criteria === undefined || isRecord(criteria),
    fault: 'has criteria that are not an object',
  }],
]);

/** What is wrong with one question as the setup wrote it, or nothing. */
function questionFault(question: unknown): string | undefined {
  if (!isRecord(question)) return 'is not a question';
  const kind = CRITERIA.get(question.type);
  if (!kind) return "needs a type: 'choice', 'noul' or 'score'";
  if (question.instructions === undefined) return 'needs instructions';
  return kind.fits(question.criteria) ? undefined : kind.fault;
}

/**
 * Why a decision profile's questions cannot be asked, or nothing. A setup file is not always
 * type-checked, so the studio reads what it exports before it trusts it.
 */
export function questionsFault(profileId: string, questions: unknown): string | undefined {
  if (!isRecord(questions) || !Object.keys(questions).length) return noQuestions(profileId);
  for (const [id, question] of Object.entries(questions)) {
    const fault = questionFault(question);
    if (fault) return `The question '${id}' the setup file exports for ${profileId} ${fault}.`;
  }
  return undefined;
}

/** Why a live profile is not run: a voice call needs a socket, and the server was given no way to take one. */
const NO_SOCKET = 'A live profile runs over a socket, and this server was not given a way to take one (`upgrade`).';

/** Each registered profile's own handler, by id; a profile that cannot be served is a problem. */
function profileHandlers(options: StudioHandlerOptions, problems: StudioProblem[]): Map<string, Serve> {
  const served = new Map<string, Serve>();
  const shared = {
    session: () => STUDIO_SESSION,
    ...(options.host ? { host: options.host } : {}),
  };
  /** A decision is asked the project's questions. The profile does not hold them, so the setup names them. */
  const decision = (profile: Profile & { type: 'decision' }): Serve | undefined => {
    const questions = options.questions?.[profile.id];
    // The description already says why a decision with no questions to ask is left out.
    if (!questions || questionsFault(profile.id, questions)) return undefined;
    const { vault, fetch } = options.provider ?? {};
    return createTheoremDecisionHandler({ profile, questions, vault, fetch });
  };
  for (const profile of listProfiles()) {
    try {
      if (profile.type === 'decision') {
        const serve = decision(profile);
        if (serve) served.set(profile.id, serve);
        continue;
      }
      if (profile.type === 'live') {
        if (options.upgrade) {
          served.set(profile.id, createStudioLiveHandler(profile, options.provider ?? {}, options.upgrade));
        } else problems.push({ profile: profile.id, message: NO_SOCKET });
        continue;
      }
      // The page shows a run's trace, so the profile is served writing its records to the run.
      served.set(
        profile.id,
        withRunTraces(
          profile.type === 'host'
            ? createTheoremHostHandler({ profile: tracedToPage(profile), ...shared })
            : createTheoremHandler({ profile: tracedToPage(profile), provider: options.provider ?? {}, ...shared }),
        ),
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
  const description = describeStudio(options.project, options.questions ?? {});
  description.asks = askBeforeWrites();
  const served = profileHandlers(options, description.problems);
  const prefix = `${base}/profiles/`;

  const run = async (request: Request, path: string): Promise<Response> => {
    const cors = corsFor(request);
    const id = decodeURIComponent(path.slice(prefix.length).split('/')[0] ?? '');
    const serve = served.get(id);
    if (!serve) return json(404, {}, cors);
    const response = await serve(request);
    // A socket's answer goes back as it is: it is not a response the page reads.
    if (response.status === 101) return response;
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
