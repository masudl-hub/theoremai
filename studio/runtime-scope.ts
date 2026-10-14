/**
 * Studio drafts, each run on a kernel scope of its own. Two visitors can
 * name the same profile, tool, or schema without either one seeing the other's.
 */
import {
  createKernelScope,
  defineProfile,
  type KernelScope,
  type Profile,
  type ProfileDefinition,
  type ToolExecutionCoordinator,
  type ProviderDefinition,
  TheoremError,
} from '../mod.ts';
import type { DetectSpec } from '../src/guardrails/detectors.ts';
import { listsPatterns } from '../src/guardrails/host-patterns.ts';
import type { ResolveHost } from '../src/guardrails/network.ts';
import type { TaintGate } from '../src/guardrails/types.ts';
import type { AgentCall, AgentCallHook, ModelProvider } from '../src/kernel/types.ts';
import {
  defineProvider,
  googleAdapter,
  openRouterAdapter,
  openAIChat,
  typesafeAdapter,
} from '../mod.ts';
import type { ProviderHostOptions } from '../src/kernel/provider-contract.ts';
import { translateProviderEvent } from '../src/providers/adapters.ts';
export interface StudioProviderOptions extends ProviderHostOptions {
  gemini?: {
    fetch?: typeof fetch;
    wait?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  };
  openAiGateway?: { baseUrl?: string; siteUrl?: string; siteName?: string; fetch?: typeof fetch };
  local?: { baseUrl: string; fetch?: typeof fetch };
}
import { STUDIO_KEY_SLOT_CAP, studioKeySlots } from './browser-connection.ts';
import { modelBindingViolation } from './policy.ts';
import { EVERY_MEDIA_KIND, localProviderAddress, standInAdapter } from './providers.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { registerStudioTools } from './tools.ts';

export interface StudioRuntime {
  providerDefinitions?: readonly ProviderDefinition[];
  execution?: ToolExecutionCoordinator;
  pageExecution?: import('../mod.ts').PageToolExecution;
  mode: 'demo' | 'byok' | 'local';
  providers?: StudioProviderOptions;
  hostOptions?: (profile: Profile, model?: string) => ProviderHostOptions;
  provider?: (profile: Profile, model?: string) => ModelProvider;
  resolveHost?: ResolveHost;
  remoteTools?: boolean;
  /** Before each agent tool call runs its agent: return `refuse` to stop it. */
  onAgentCall?: (call: AgentCall) => { refuse: string } | void | Promise<{ refuse: string } | void>;
}

/** The provider a profile's turn runs on: the runtime's own, or one from its vault. */
export function runtimeProvider(
  runtime: StudioRuntime,
  scope: KernelScope,
  profile: Profile,
  model?: string,
): ProviderHostOptions {
  const mock = runtime.provider?.(profile, model);
  if (mock && profile.type !== 'host') {
    const selected =
      model ?? ('defaultModel' in profile ? profile.defaultModel : Object.keys(profile.models)[0]);
    const binding = profile.models[selected];
    const id = `demo:${profile.id}`;
    scope.providers.register(
      defineProvider({
        id,
        connection: {},
        adapter: {
          ...standInAdapter('studio-script'),
          capabilities: () => ({
            profileTypes: ['text', 'image', 'speech'],
            features: {
              streaming: 'supported',
              clientTools: 'supported',
              parallelTools: 'supported',
              structuredOutput: 'supported',
              thinking: 'supported',
              summaries: 'supported',
              storedContinuation: 'unsupported',
            },
            ...EVERY_MEDIA_KIND,
            builtins: ['googleSearch', 'googleMaps', 'urlContext', 'codeExecution'],
          }),
          create(): Promise<import('../src/kernel/provider-contract.ts').ProviderOperations> {
            return Promise.resolve().then(() => {
              return {
                async *complete(request) {
                  let done = false;
                  for await (const event of mock.complete(request)) {
                    const converted = translateProviderEvent(event);
                    if (converted) {
                      if (converted.type === 'done') done = true;
                      yield converted;
                    }
                  }
                  if (!done) yield { type: 'done', stop: { kind: 'completed' } };
                },
              };
            });
          },
        },
      }),
    );
    scope.profiles.register({
      ...profile,
      models: { ...profile.models, [selected]: { ...binding, provider: id } },
    } as Profile);
  }
  const options = runtime.providers ?? {};
  const host = runtime.hostOptions?.(profile, model) ?? {};
  return {
    ...host,
    vault: host.vault ?? options.vault,
    fetch:
      host.fetch ??
      options.fetch ??
      options.gemini?.fetch ??
      options.openAiGateway?.fetch ??
      options.local?.fetch,
    wait: host.wait ?? options.wait ?? options.gemini?.wait,
  };
}
function registerRuntimeProviders(scope: KernelScope, runtime?: StudioRuntime) {
  const options = runtime?.providers;
  scope.providers.register(
    defineProvider({ id: 'google', connection: {}, adapter: googleAdapter() }),
  );
  scope.providers.register(
    defineProvider({
      id: 'openrouter',
      connection: Object.fromEntries(
        Object.entries({
          baseURL: options?.openAiGateway?.baseUrl,
          siteUrl: options?.openAiGateway?.siteUrl,
          siteName: options?.openAiGateway?.siteName,
        }).filter(([, value]) => value !== undefined),
      ),
      adapter: openRouterAdapter(),
    }),
  );
  scope.providers.register(
    defineProvider({ id: 'typesafe', connection: {}, adapter: typesafeAdapter() }),
  );
  scope.providers.register(
    defineProvider({
      id: 'local',
      connection: { baseURL: localProviderAddress(options?.local?.baseUrl) },
      adapter: openAIChat(),
    }),
  );
  for (const definition of runtime?.providerDefinitions ?? []) scope.providers.register(definition);
}

/**
 * Each called agent runs on a provider of its own, so it reads its own key
 * slots and may use another provider than its caller. The runtime may refuse
 * the call first.
 */
export function agentCallHook(scope: KernelScope, runtime: StudioRuntime): AgentCallHook {
  return async (call) => {
    const refused = await runtime.onAgentCall?.(call);
    if (refused) return refused;
    return { provider: runtimeProvider(runtime, scope, scope.profiles.get(call.profile)) };
  };
}

/** Where a run's tools may reach, from what the studio runs it on. */
type RuntimeNetwork = 'public' | 'asWritten' | 'none';

/** The parts of a runtime that decide its network. */
export type NetworkRuntime = Pick<StudioRuntime, 'mode' | 'remoteTools'> & {
  providers?: { local?: unknown };
};

/**
 * The studio's own server drops the draft's network exemptions, which are for the host the
 * profile is exported to. A local model with remote tools off reaches no host.
 */
function runtimeNetwork(runtime: NetworkRuntime): RuntimeNetwork {
  if (runtime.mode === 'demo') return 'public';
  return (runtime.mode === 'local' || runtime.providers?.local) && !runtime.remoteTools
    ? 'none'
    : 'asWritten';
}

const NETWORK_NOTES: Record<RuntimeNetwork, string> = {
  public: 'Studio server: public hosts only.',
  asWritten: 'Browser runs: rules as written.',
  none: 'Remote tools off: no host reached.',
};

/** What the studio does with the Network section on `runtime`. */
function studioNetworkNote(runtime: NetworkRuntime): string {
  return NETWORK_NOTES[runtimeNetwork(runtime)];
}

/**
 * Once a turn has read a remote tool's result, a destructive call is refused: fetched text can't
 * steer the agent into deleting or overwriting. A draft that asks for stricter keeps it.
 */
const STUDIO_TAINT_NOTE =
  'Studio runs refuse destructive calls after a remote read. Stricter settings hold.';

function withRemoteReadGate<G extends { taint?: { afterRemoteRead?: TaintGate } }>(
  guardrails: G,
): G {
  if (guardrails.taint?.afterRemoteRead === 'write') return guardrails;
  return {
    ...guardrails,
    taint: { ...guardrails.taint, afterRemoteRead: 'destructive' },
  };
}

function runtimeGuardrails<G extends { network?: unknown }>(
  guardrails: G,
  runtime: StudioRuntime,
): G {
  switch (runtimeNetwork(runtime)) {
    case 'public':
      return { ...guardrails, network: undefined };
    case 'none':
      return { ...guardrails, network: { allowedSchemes: [] } };
    case 'asWritten':
      return guardrails;
  }
}

function runtimeProfileDefinition(
  def: ProfileDefinition,
  runtime: StudioRuntime,
): ProfileDefinition {
  // Preserve narrowed guardrail types (speech forbids canaries; decisions have their own policy).
  if (def.type === 'speech') {
    return {
      ...def,
      guardrails: withRemoteReadGate(runtimeGuardrails(def.guardrails ?? {}, runtime)),
    };
  }
  // A host runs one tool per call, so a turn never reads before it acts; the kernel refuses taint there.
  if (def.type === 'host') {
    return {
      ...def,
      guardrails: runtimeGuardrails(def.guardrails ?? {}, runtime),
    };
  }
  if (def.type === 'decision') return def;
  return {
    ...def,
    guardrails: withRemoteReadGate(runtimeGuardrails(def.guardrails ?? {}, runtime)),
  };
}

/**
 * `def` with the table compiled for each detector's patterns, here where the draft runs: a table
 * a browser sent is never trusted, since compiling is what refuses a pattern that could hang on
 * hostile text. The compiler loads only for a draft that has patterns.
 */
export async function withCompiledPatterns<D extends ProfileDefinition>(def: D): Promise<D> {
  if (!hasPatterns(def)) return def;
  const { compileDetect } = await import('../src/guardrails/compile-egress.ts');
  return withPatterns(def, compileDetect);
}

/** Whether `def` has a detector that lists patterns to compile. */
function hasPatterns(def: ProfileDefinition): boolean {
  const detect = def.guardrails && 'detect' in def.guardrails ? def.guardrails.detect : undefined;
  return typeof detect === 'object' && listsPatterns(detect);
}

/** `def` with its patterns compiled by `compile`, for a caller that already holds the compiler. */
export function withPatterns<D extends ProfileDefinition>(
  def: D,
  compile: (detect: DetectSpec) => DetectSpec,
): D {
  if (!hasPatterns(def)) return def;
  const guardrails = def.guardrails as { detect: DetectSpec };
  return { ...def, guardrails: { ...guardrails, detect: compile(guardrails.detect) } };
}

/**
 * Refuses a tool schema a browser sent whose `pattern` could hang on text a model writes: zod
 * runs it on every call, here on the run's server. It is the check the kernel makes of a
 * detector's patterns, and loads only for a draft whose schemas have patterns.
 */
async function refuseSlowSchemaPatterns(tools: readonly ToolRegistration[]): Promise<void> {
  const found = tools.flatMap((tool) =>
    (['input', 'output'] as const).flatMap((side) =>
      schemaPatterns((tool as { inputSchema?: unknown; outputSchema?: unknown })[`${side}Schema`]).map(
        (source) => ({ tool: tool.name, side, source }),
      ),
    ),
  );
  if (!found.length) return;
  const { slowPatternProblem } = await import('../src/guardrails/egress-compiler.ts');
  for (const { tool, side, source } of found) {
    const slow = slowPatternProblem(source);
    if (slow) {
      // labels-exempt: builder diagnostic
      throw new TheoremError('config', `${tool}: the pattern /${source}/ in its ${side} schema ${slow}`);
    }
  }
}

/** Every regular expression a JSON Schema holds: each `pattern`, and each `patternProperties` key. */
function schemaPatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaPatterns);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    ...(key === 'pattern' && typeof inner === 'string' ? [inner] : []),
    ...(key === 'patternProperties' && inner && typeof inner === 'object' ? Object.keys(inner) : []),
    ...schemaPatterns(inner),
  ]);
}

/** Registers the draft's tools, schema, and profile into `scope`, as the runtime runs it. */
async function registerDraft(
  scope: KernelScope,
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: StudioRuntime,
): Promise<Profile> {
  if (studioKeySlots(profile).length > STUDIO_KEY_SLOT_CAP) {
    throw new TheoremError('config', 'The studio supports up to 32 key slots.'); // labels-exempt: builder diagnostic
  }
  await refuseSlowSchemaPatterns(customTools);
  const defined = defineProfile(
    runtimeProfileDefinition(await withCompiledPatterns(profile), runtime),
  );
  if (defined.type !== 'host') {
    for (const binding of Object.values(defined.models)) {
      const violation = modelBindingViolation(
        {
          provider: binding.provider,
          adapter: scope.providers.require(binding.provider).adapter.id,
          apiId: binding.apiId,
          decision: defined.type === 'decision',
          builtInTools: 'builtInTools' in binding ? (binding.builtInTools ?? []) : [],
        },
        runtime.mode,
      );
      if (violation) throw new TheoremError('config', violation.message); // labels-exempt: builder connection diagnostic
    }
  }
  return registerDefined(scope, defined, customTools, structured);
}

/** Registers a draft's tools and schema, then its profile, into `scope`. */
export function registerDefined(
  scope: KernelScope,
  profile: Profile,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
): Profile {
  registerStudioTools(scope.tools, customTools);
  if (structured && profile.type !== 'live') {
    scope.schemas.register(structured.id, structured.spec);
  }
  scope.profiles.register(profile);
  return profile;
}

/** An agent the run's agent names, registered before it: one its agent tools run, or its summariser. */
export interface StudioDependency {
  profile: ProfileDefinition;
  customTools: readonly ToolRegistration[];
  structured?: StructuredRegistration;
}

/**
 * A new scope holding one request's draft, and the profile to run on it. Never cache or share it:
 * the scope also holds MCP sessions, and a shared one would hand a keyless server's session to
 * every visitor and keep it past the request. `dependencies` are registered first, in order.
 */
export async function studioScope(
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: StudioRuntime,
  dependencies: readonly StudioDependency[] = [],
): Promise<{ scope: KernelScope; profile: Profile }> {
  const scope = createKernelScope();
  registerRuntimeProviders(scope, runtime);
  for (const dependency of dependencies) {
    await registerDraft(
      scope,
      dependency.profile,
      dependency.customTools,
      dependency.structured,
      runtime,
    );
  }
  return {
    scope,
    profile: await registerDraft(scope, profile, customTools, structured, runtime),
  };
}

/**
 * A new scope holding drafts as written, the last one returned: no runtime
 * rewrites their guardrails or checks their model bindings. For a run that
 * calls no model and reaches no host. Never cache or share it.
 */
export async function writtenScope(drafts: readonly StudioDependency[]): Promise<{
  scope: KernelScope;
  profile: Profile | undefined;
}> {
  const scope = createKernelScope();
  registerRuntimeProviders(scope);
  let profile: Profile | undefined;
  for (const draft of drafts) {
    await refuseSlowSchemaPatterns(draft.customTools);
    profile = registerDefined(
      scope,
      defineProfile(await withCompiledPatterns(draft.profile)),
      draft.customTools,
      draft.structured,
    );
  }
  return { scope, profile };
}

export { STUDIO_TAINT_NOTE, studioNetworkNote };
