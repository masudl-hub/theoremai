/**
 * Playground drafts, each run on a kernel scope of its own. Two visitors can
 * name the same profile, tool, or schema without either one seeing the other's.
 */
import {
  createKernelScope,
  defineProfile,
  type KernelScope,
  type Profile,
  type ProfileDefinition,
  TheoremError,
} from '../mod.ts';
import { listsPatterns } from '../src/guardrails/host-patterns.ts';
import type { ResolveHost } from '../src/guardrails/network.ts';
import type { TaintGate } from '../src/guardrails/types.ts';
import type { AgentCall, AgentCallHook, ModelProvider } from '../src/kernel/types.ts';
import {
  z,
  defineProvider,
  googleAdapter,
  openRouterAdapter,
  openAIChat,
  typesafeAdapter,
} from '../mod.ts';
import type { ProviderHostOptions } from '../src/kernel/provider-contract.ts';
import { translateProviderEvent } from '../src/providers/adapters.ts';
export interface PlaygroundProviderOptions extends ProviderHostOptions {
  gemini?: {
    fetch?: typeof fetch;
    wait?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  };
  openAiGateway?: { baseUrl?: string; siteUrl?: string; siteName?: string; fetch?: typeof fetch };
  local?: { baseUrl: string; fetch?: typeof fetch };
}
import { PLAYGROUND_KEY_SLOT_CAP, playgroundKeySlots } from './browser-connection.ts';
import { modelBindingViolation } from './policy.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { registerPlaygroundTools } from './tools.ts';

export interface PlaygroundRuntime {
  mode: 'demo' | 'byok' | 'local';
  providers?: PlaygroundProviderOptions;
  hostOptions?: (profile: Profile, model?: string) => ProviderHostOptions;
  provider?: (profile: Profile, model?: string) => ModelProvider;
  resolveHost?: ResolveHost;
  remoteTools?: boolean;
  /** Before each agent tool call runs its agent: return `refuse` to stop it. */
  onAgentCall?: (call: AgentCall) => { refuse: string } | void | Promise<{ refuse: string } | void>;
}

/** The provider a profile's turn runs on: the runtime's own, or one from its vault. */
export function runtimeProvider(
  runtime: PlaygroundRuntime,
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
          apiVersion: 1,
          id: 'playground-script',
          connectionSchema: z.strictObject({}),
          optionsSchema: z.record(z.string(), z.json()),
          credentialSchema: z.string(),
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
            inputKinds: ['text', 'image', 'audio', 'video', 'document'],
            outputKinds: ['text', 'image', 'audio'],
            builtins: ['googleSearch', 'googleMaps', 'urlContext', 'codeExecution'],
          }),
          validateRequest() {},
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
export function registerRuntimeProviders(scope: KernelScope, runtime?: PlaygroundRuntime) {
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
      connection: {
        baseURL: `${(options?.local?.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
      },
      adapter: openAIChat(),
    }),
  );
}

/**
 * Each called agent runs on a provider of its own, so it reads its own key
 * slots and may use another provider than its caller. The runtime may refuse
 * the call first.
 */
export function agentCallHook(scope: KernelScope, runtime: PlaygroundRuntime): AgentCallHook {
  return async (call) => {
    const refused = await runtime.onAgentCall?.(call);
    if (refused) return refused;
    return { provider: runtimeProvider(runtime, scope, scope.profiles.get(call.profile)) };
  };
}

/** Where a run's tools may reach, from what the playground runs it on. */
type RuntimeNetwork = 'public' | 'asWritten' | 'none';

/** The parts of a runtime that decide its network. */
export type NetworkRuntime = Pick<PlaygroundRuntime, 'mode' | 'remoteTools'> & {
  providers?: { local?: unknown };
};

/**
 * The playground's own server drops the draft's network exemptions, which are for the host the
 * profile is exported to. A local model with remote tools off reaches no host.
 */
function runtimeNetwork(runtime: NetworkRuntime): RuntimeNetwork {
  if (runtime.mode === 'demo') return 'public';
  return (runtime.mode === 'local' || runtime.providers?.local) && !runtime.remoteTools
    ? 'none'
    : 'asWritten';
}

const NETWORK_NOTES: Record<RuntimeNetwork, string> = {
  public: 'Playground server: public hosts only.',
  asWritten: 'Browser runs: rules as written.',
  none: 'Remote tools off: no host reached.',
};

/** What the playground does with the Network section on `runtime`. */
function playgroundNetworkNote(runtime: NetworkRuntime): string {
  return NETWORK_NOTES[runtimeNetwork(runtime)];
}

/**
 * Once a turn has read a remote tool's result, a destructive call is refused: fetched text can't
 * steer the agent into deleting or overwriting. A draft that asks for stricter keeps it.
 */
const PLAYGROUND_TAINT_NOTE =
  'Playground runs refuse destructive calls after a remote read. Stricter settings hold.';

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
  runtime: PlaygroundRuntime,
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
  runtime: PlaygroundRuntime,
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
async function withCompiledPatterns<D extends ProfileDefinition>(def: D): Promise<D> {
  const { guardrails } = def;
  if (!guardrails || !('detect' in guardrails)) return def;
  const { detect } = guardrails;
  if (typeof detect !== 'object' || !listsPatterns(detect)) return def;
  const { compileDetect } = await import('../src/guardrails/compile-egress.ts');
  return { ...def, guardrails: { ...guardrails, detect: compileDetect(detect) } };
}

/** Registers the draft's tools, schema, and profile into `scope`, as the runtime runs it. */
async function registerDraft(
  scope: KernelScope,
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: PlaygroundRuntime,
): Promise<Profile> {
  if (playgroundKeySlots(profile).length > PLAYGROUND_KEY_SLOT_CAP) {
    throw new TheoremError('config', 'The playground supports up to 32 key slots.'); // lexicon-exempt: builder diagnostic
  }
  const defined = defineProfile(
    runtimeProfileDefinition(await withCompiledPatterns(profile), runtime),
  );
  if (defined.type !== 'host') {
    for (const binding of Object.values(defined.models)) {
      const violation = modelBindingViolation(
        {
          ...binding,
          protocol:
            defined.type === 'decision'
              ? 'decision'
              : binding.provider === 'google'
                ? defined.type === 'live'
                  ? 'geminiLive'
                  : 'geminiInteractions'
                : 'openAi',
          builtInTools: 'builtInTools' in binding ? (binding.builtInTools ?? []) : [],
        },
        runtime.mode,
      );
      if (violation) throw new TheoremError('config', violation.message); // lexicon-exempt: builder connection diagnostic
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
  registerPlaygroundTools(scope.tools, customTools);
  if (structured && profile.type !== 'live') {
    scope.schemas.register(structured.id, structured.spec);
  }
  scope.profiles.register(profile);
  return profile;
}

/** An agent the run's agent names, registered before it: one its agent tools run, or its summariser. */
export interface PlaygroundDependency {
  profile: ProfileDefinition;
  customTools: readonly ToolRegistration[];
  structured?: StructuredRegistration;
}

/**
 * A new scope holding one request's draft, and the profile to run on it. Never cache or share it:
 * the scope also holds MCP sessions, and a shared one would hand a keyless server's session to
 * every visitor and keep it past the request. `dependencies` are registered first, in order.
 */
export async function playgroundScope(
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: PlaygroundRuntime,
  dependencies: readonly PlaygroundDependency[] = [],
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
export async function writtenScope(drafts: readonly PlaygroundDependency[]): Promise<{
  scope: KernelScope;
  profile: Profile | undefined;
}> {
  const scope = createKernelScope();
  registerRuntimeProviders(scope);
  let profile: Profile | undefined;
  for (const draft of drafts) {
    profile = registerDefined(
      scope,
      defineProfile(await withCompiledPatterns(draft.profile)),
      draft.customTools,
      draft.structured,
    );
  }
  return { scope, profile };
}

export { PLAYGROUND_TAINT_NOTE, playgroundNetworkNote };
