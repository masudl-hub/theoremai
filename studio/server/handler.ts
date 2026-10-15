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
  defineProfile,
  getStructured,
  listProfiles,
  listProviders,
  listTools,
  type Profile,
  type ProviderHostOptions,
  type RegisteredProvider,
  registerTool,
  turnShortfalls,
} from '@theoremjs/agents';
import { compileDetect } from '@theoremjs/agents/guardrails/compile';
import {
  createSealedConversationStore,
  createTheoremDecisionHandler,
  createTheoremHandler,
  createTheoremHostHandler,
  type TheoremConversationStore,
} from '@theoremjs/react/server';
import { type StudioAsks, studioAsks } from '../asks.ts';
import { adapterFactory, declaresSupport, providerDefinition, type StudioProvider, toldSupport } from '../providers.ts';
import { createBlankDraft, type StudioDraft, type ToolSpecDraft } from '../draft.ts';
import { shownConnection, withoutCredentials } from '../held-credentials.ts';
import { STUDIO_TRACE_DESTINATION } from '../policy.ts';
import { differingSettings } from '../agreement.ts';
import { compileWorkspace } from '../compile-workspace.ts';
import { ON_OWN_KEYS } from '../lent-keys.ts';
import { readStudioSource } from '../read-source.ts';
import { withPatterns } from '../runtime-scope.ts';
import { STUDIO_READER } from '../reader.ts';
import type { ToolRegistration } from '../registrations.ts';
import { studioSource } from '../source.ts';
import { createStudioLiveHandler, type StudioUpgrade } from './live.ts';
import { tracedToPage, withDecisionTraces, withRunTraces } from './run-traces.ts';
import type { ProjectOrigins, ProviderPlace, SharedSetting, Unregistered } from './save-wire.ts';
import {
  addAgent,
  agentNodeId,
  createBlankWorkspace,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../workspace.ts';

/** One builder on one machine: every request is the same session, so a gate's answer finds its call. */
const STUDIO_SESSION = 'theorem-studio-local';

/** A profile the page could not show or run, and why. */
export type StudioProblem = { profile: string; message: string };

/** A model that cannot run as the project's files set it, and why. Its agent still opens and runs. */
export type StudioModelProblem = { profile: string; model: string; message: string };

/** A profile or provider the studio shows differently from the project, and each setting it differs in, by path. */
export type StudioDifference = { kind: 'profile' | 'provider'; of: string; settings: string[] };

/** What the page opens. */
export type StudioDescription = {
  project: string;
  /** The project as the studio holds one: an agent per profile, and the tools they share. */
  workspace: StudioWorkspace;
  problems: StudioProblem[];
  /** The models that cannot run as the files set them. None when every one can. */
  modelProblems?: StudioModelProblem[];
  /** Where what the studio shows is not what the project registered. None when they agree. */
  differences?: StudioDifference[];
  /** Why the project does not compile as the studio opened it, when it does not. */
  unheld?: string[];
  /** The settings several profiles share. The studio command reads them from the project's files. */
  shared?: SharedSetting[];
  /** The settings the project's files set in code, which the studio shows and does not change. */
  origins?: ProjectOrigins;
  /** The profiles and tools the files define that the project did not register. */
  unregistered?: Unregistered[];
  /** Where the files define each provider the project registered. */
  providerPlaces?: ProviderPlace[];
  /** The tools that write: the ones the studio makes ask before each run, and the ones it cannot. */
  asks: StudioAsks;
  /** What the project printed when its files stopped loading. The page then shows the last load that did. */
  unloaded?: string;
  /** The editor the studio command opens files in when the page names none, by its command. */
  editor?: string;
  /** The setup file the studio command was started on, from the folder it ran in. */
  setup?: string;
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
  /**
   * The key the chats' conversations are sealed with. `serve.ts` makes one per
   * studio run and hands it to every load, so a chat outlives a Save or an edit.
   */
  conversationKey: string;
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
      // A credential in its URL or headers stays in this load: the page gets a mask.
      return withoutCredentials(plainSetting(fields) as ToolRegistration);
    });
}

type ProfileRead =
  | { ok: true; draft: StudioDraft; registered: ToolSpecDraft[] }
  | { ok: false; message: string };

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

/** What a provider's models are told they support, as the kernel runs it: none when it is the adapter's defaults. */
function toldTo(provider: RegisteredProvider): Pick<StudioProvider, 'capabilities'> {
  // A project's own adapter is not asked: what it says is its code's.
  if (!declaresSupport(provider.adapter.id)) return {};
  const asked = provider.adapter.capabilities({ apiId: '', connection: provider.connection, providerOptions: {} });
  const capabilities = toldSupport(provider.adapter.id, asked);
  return capabilities ? { capabilities } : {};
}

/**
 * The project's providers as the page gets them: the adapter each is defined on, its key slots,
 * what it connects with when its adapter is the kernel's, and what its models support when its
 * adapter is told. What a project's own adapter connects with is its own to say, so it stays here.
 */
function registeredProviders(): StudioProvider[] {
  return listProviders().map((provider) => {
    const connection = adapterFactory(provider.adapter.id) ? shownConnection(provider.connection) : undefined;
    return {
      id: provider.id,
      adapter: provider.adapter.id,
      ...(connection ? { connection } : {}),
      ...(provider.keySlot ? { keySlot: provider.keySlot } : {}),
      ...(provider.fallbackKeySlot ? { fallbackKeySlot: provider.fallbackKeySlot } : {}),
      ...toldTo(provider),
    };
  });
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
      profile: printableProfile(profile) as Parameters<typeof studioSource>[0]['profile'],
      customTools: [...tools],
      providers: registeredProviders(),
      ...(structured ? { structured } : {}),
    });
    const read = readStudioSource(source, createBlankDraft());
    if (!read.ok) return { ok: false, message: read.errors.map((error) => error.message).join(' ') };
    return { ok: true, draft: read.draft, registered: read.registered };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Each opened profile that is not the one the project registered: what the workspace compiles to
 * for it, beside the registered profile. A workspace that does not compile holds something the
 * kernel took and the studio does not: that is said whole, in the studio's own words.
 */
function disagreements(workspace: StudioWorkspace): { differences: StudioDifference[]; unheld: string[] } {
  const compiled = compileWorkspace(workspace, ON_OWN_KEYS);
  if (!compiled.ok) return { differences: [], unheld: compiled.issues.map((issue) => issue.message) };
  const registered = new Map(listProfiles().map((profile) => [profile.id as string, profile]));
  const differences = compiled.agents.flatMap((agent): StudioDifference[] => {
    const profile = registered.get(agent.agentId);
    if (!profile) return [];
    const shown = plainSetting(defineProfile(withPatterns(agent.profile, compileDetect)));
    const settings = differingSettings(plainSetting(printableProfile(profile)), shown);
    return settings.length ? [{ kind: 'profile', of: agent.agentId, settings }] : [];
  });
  return { differences: [...differences, ...providerDifferences(workspace)], unheld: [] };
}

/**
 * Each opened provider that is not the one the project registered: the provider the kernel defines
 * from what the studio holds, beside the registered one. What a project's own adapter connects
 * with stays with the project, so only its adapter and its slots are compared.
 */
function providerDifferences(workspace: StudioWorkspace): StudioDifference[] {
  const registered = new Map(listProviders().map((provider) => [provider.id, provider]));
  const read = (provider: RegisteredProvider, connects: boolean) =>
    plainSetting({
      adapter: provider.adapter.id,
      ...(connects ? { connection: provider.connection } : {}),
      keySlot: provider.keySlot,
      fallbackKeySlot: provider.fallbackKeySlot,
      ...toldTo(provider),
    });
  return workspace.providers.flatMap((provider): StudioDifference[] => {
    const held = registered.get(provider.id);
    if (!held) return [];
    const connects = adapterFactory(provider.adapter) !== undefined;
    let shown: RegisteredProvider;
    try {
      shown = providerDefinition(provider);
    } catch {
      // The kernel took a connection the studio cannot define again: all of it is shown differently.
      return [{ kind: 'provider', of: provider.id, settings: ['connection'] }];
    }
    const settings = differingSettings(read(held, connects), read(shown, connects));
    return settings.length ? [{ kind: 'provider', of: provider.id, settings }] : [];
  });
}

/** The agent that writes each model's summaries, by the model's name, where a profile names one. */
function compactors(profile: Profile): Record<string, string> {
  const models = 'models' in profile && isRecord(profile.models) ? profile.models : {};
  return Object.fromEntries(Object.entries(models).flatMap(([name, model]) => {
    const writer = isRecord(model) && isRecord(model.compaction) ? model.compaction.profile : undefined;
    return typeof writer === 'string' ? [[name, writer] as const] : [];
  }));
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
  const modelProblems: StudioModelProblem[] = [];
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
  // A model's summaries are written by an agent it names by id, found the same way.
  const writers = new Map(listProfiles().map((profile) => [profile.id as string, compactors(profile)]));
  const agents = opened.agents.map((agent) => {
    const named = writers.get(agent.identity.agentId);
    const modelBindings = agent.modelBindings.map((binding) => {
      const id = binding.compactWith ? undefined : named?.[binding.modelId];
      if (!id) return binding;
      const key = opened.agents.find((each) => each.identity.agentId === id)?.key;
      // A blank writer is the agent itself, so a writer this project does not open is said, not dropped.
      if (!key) {
        modelProblems.push({
          profile: agent.identity.agentId,
          model: binding.modelId,
          message: `It has '${id}' write its summaries, and this project registers no agent '${id}'.`,
        });
        return binding;
      }
      return { ...binding, compactWith: key };
    });
    return modelBindings.some((binding, index) => binding !== agent.modelBindings[index])
      ? { ...agent, modelBindings }
      : agent;
  });
  // The kernel's own check as a turn starts, made now: a model its provider cannot run is said at open.
  for (const agent of agents) {
    for (const { model, message } of turnShortfalls(agent.identity.agentId)) {
      modelProblems.push({ profile: agent.identity.agentId, model, message });
    }
  }
  // The project's own providers are the ones a model here can name.
  const registered = registeredProviders();
  const providers = registered.length > 0 ? registered : opened.providers;
  const whole: StudioWorkspace = {
    ...opened,
    providers,
    agents,
    toolSpecs,
    // What opened is what the files hold: nothing here is a change yet.
    starts: {
      ...opened.starts,
      agents: Object.fromEntries(agents.map((agent) => [agent.key, agent])),
      tools: Object.fromEntries(toolSpecs.map((tool) => [tool.key, tool])),
      providers: Object.fromEntries(providers.map((provider) => [provider.id, provider])),
    },
    ...(first ? { selected: agentNodeId(first.key), chatWith: first.key } : {}),
  };
  const { differences, unheld } = disagreements(whole);
  return {
    project,
    workspace: whole,
    problems,
    ...(modelProblems.length ? { modelProblems } : {}),
    ...(differences.length ? { differences } : {}),
    ...(unheld.length ? { unheld } : {}),
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
 * this machine. A browser's request that names no page at all (an image or a script tag, an
 * address typed in) is refused too: the studio's page always names itself.
 */
export function isForeign(
  request: Request,
  options: Pick<StudioHandlerOptions, 'listenHost' | 'pageOrigins'>,
): boolean {
  if (request.headers.get('host') !== options.listenHost) return true;
  const origin = request.headers.get('origin');
  // Only a browser says where a request was fetched from; the studio's command and server say nothing.
  if (origin === null) return request.headers.has('sec-fetch-site');
  return !options.pageOrigins.includes(origin);
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
    clientEvents: STUDIO_READER,
    ...(options.host ? { host: options.host } : {}),
  };
  // One store for every chat profile: one key, one session, so any of them opens a ref.
  let conversationStore: TheoremConversationStore | undefined;
  const chatStore = () =>
    (conversationStore ??= createSealedConversationStore({
      keys: { 1: options.conversationKey },
      keyVersion: 1,
    }));
  /** A decision is asked the project's questions. The profile does not hold them, so the setup names them. */
  const decision = (profile: Profile & { type: 'decision' }): Serve | undefined => {
    const questions = options.questions?.[profile.id];
    // The description already says why a decision with no questions to ask is left out.
    if (!questions || questionsFault(profile.id, questions)) return undefined;
    const { vault, fetch } = options.provider ?? {};
    // The page shows a decision's trace, so the profile is served writing its records to the reply.
    return withDecisionTraces(
      createTheoremDecisionHandler({ profile: tracedToPage(profile), questions, vault, fetch, clientEvents: STUDIO_READER }),
    );
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
            : createTheoremHandler({
                profile: tracedToPage(profile),
                provider: options.provider ?? {},
                // A stateless profile keeps no conversation, so it takes no store.
                ...(profile.providerContinuation?.history === 'stateless'
                  ? {}
                  : { conversationStore: chatStore() }),
                ...shared,
              }),
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
