/**
 * Studio drafts, each run on a kernel scope of its own. Two visitors can
 * name the same profile, tool, or schema without either one seeing the other's.
 */
import {
  createKernelScope,
  defineProfile,
  defineProtocol,
  defineProvider,
  type KernelScope,
  type Profile,
  type ProfileDefinition,
  type Provider,
  type ResolveHost,
  TheoremError,
  type ToolExecutionCoordinator,
} from '@theoremjs/agents';
import {
  type DetectSpec,
  listsPatterns,
  TAINT_GATES,
  type TaintGate,
} from '@theoremjs/agents/guardrails';
import type {
  AgentCall,
  AgentCallHook,
  ModelEvent,
  ModelRequest,
  ProtocolEvent,
  ProviderHostOptions,
  TurnModel,
} from '@theoremjs/agents/kernel';
import { z } from 'zod';
export interface StudioProviderOptions extends ProviderHostOptions {
  local?: { baseUrl: string; fetch?: typeof fetch };
}
import { STUDIO_KEY_SLOT_CAP, studioKeySlots } from './browser-connection.ts';
import { lentCompression, type StudioRunsOn } from './lent-keys.ts';
import { modelBindingViolation } from './policy.ts';
import { localProviderAddress, registerStudioProvider, STUDIO_PROVIDERS } from './providers.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { registerStudioTools, type StudioToolHandlers } from './tools.ts';

/** What a run holds besides what it runs on. */
export interface StudioRuntimeBase {
  /** A project's own provider definitions, registered after the studio's. */
  providerDefinitions?: readonly Provider[];
  execution?: ToolExecutionCoordinator;
  pageExecution?: import('@theoremjs/agents').PageToolExecution;
  providers?: StudioProviderOptions;
  hostOptions?: (profile: Profile, model?: string) => ProviderHostOptions;
  /** Answers every model call with a scripted model, in place of the profile's provider. */
  provider?: (profile: Profile, model?: string) => TurnModel;
  resolveHost?: ResolveHost;
  remoteTools?: boolean;
  /** Handlers the host runs for function tools, by name. A tool with none answers with its stub. */
  toolHandlers?: StudioToolHandlers;
  /** Before each agent tool call runs its agent: return `refuse` to stop it. */
  onAgentCall?: (call: AgentCall) => { refuse: string } | void | Promise<{ refuse: string } | void>;
}

/** A run, and what it runs on: a run on lent keys carries the keys it is held to. */
export type StudioRuntime = StudioRuntimeBase & StudioRunsOn;

/** The protocol event a scripted model's event stands for. */
function protocolEvent(event: ModelEvent): ProtocolEvent {
  if (event.type === 'tool') return { type: 'tool_call', call: event.tool } as ProtocolEvent;
  if (event.type === 'done') {
    return { type: 'done', stop: event.stop, ...(event.interrupted ? { interrupted: true } : {}) } as ProtocolEvent;
  }
  return event as ProtocolEvent;
}

/** A provider whose one protocol answers every call with `model`, sending nothing. */
function scriptedProvider(id: string, protocolId: string, model: TurnModel): Provider {
  const protocol = defineProtocol({
    id: protocolId,
    name: 'Scripted',
    description: 'Answers with the events a scripted model gives.',
    endpoints: { text: '/', image: '/', speech: '/' },
    options: z.record(z.string(), z.json()),
    create: (context) => ({
      async *complete(request) {
        let done = false;
        // why: a scripted model writes whatever built-ins the binding names.
        for await (const event of model.complete({ ...request, builtInTools: context.builtInTools } as unknown as ModelRequest)) {
          if (event.type === 'done') done = true;
          yield protocolEvent(event);
        }
        if (!done) yield { type: 'done', stop: { kind: 'completed' } };
      },
    }),
  });
  return defineProvider({
    id,
    name: 'Scripted',
    description: 'Answers with a scripted model.',
    serves: () => [{ protocol, baseUrl: 'https://scripted.invalid' }],
  }) as Provider;
}

/**
 * The host options a profile's turn runs with. A runtime with a scripted model registers it as a
 * provider of its own and binds the profile's model to it.
 */
export function runtimeProvider(
  runtime: StudioRuntime,
  scope: KernelScope,
  profile: Profile,
  model?: string,
): ProviderHostOptions {
  const scripted = runtime.provider?.(profile, model);
  if (scripted && profile.type !== 'host') {
    const selected =
      model ?? ('defaultModel' in profile ? profile.defaultModel : Object.keys(profile.models)[0]);
    const binding = profile.models[selected];
    const id = `scripted-${profile.id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    // why: a protocol id is letters and digits only; a provider id may hold hyphens.
    const protocol = id.replaceAll('-', '');
    scope.providers.replace(scriptedProvider(id, protocol, scripted));
    scope.profiles.register({
      ...profile,
      models: { ...profile.models, [selected]: { ...binding, protocol, provider: id, options: {}, keySlot: undefined, fallbackKeySlot: undefined } },
    } as Profile);
  }
  const options = runtime.providers ?? {};
  const host = runtime.hostOptions?.(profile, model) ?? {};
  return {
    ...host,
    vault: host.vault ?? options.vault,
    fetch: host.fetch ?? options.fetch ?? options.local?.fetch,
    wait: host.wait ?? options.wait,
  };
}
/** The studio's providers, the local one at the runtime's address, then the project's own. */
function registerRuntimeProviders(scope: KernelScope, runtime?: StudioRuntime) {
  const local = runtime?.providers?.local?.baseUrl;
  for (const provider of STUDIO_PROVIDERS) {
    registerStudioProvider(
      scope.providers,
      provider.definition === 'local' && local
        ? { ...provider, connection: { baseUrl: localProviderAddress(local) } }
        : provider,
    );
  }
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
export type NetworkRuntime = StudioRunsOn &
  Pick<StudioRuntimeBase, 'remoteTools'> & { providers?: { local?: unknown } };

/**
 * Lent keys that hold runs to public hosts drop the draft's network rules. A local model with
 * remote tools off reaches no host. Otherwise the rules run as written.
 */
function runtimeNetwork(runtime: NetworkRuntime): RuntimeNetwork {
  if (runtime.mode === 'demo') return runtime.keys.holds.publicHostsOnly ? 'public' : 'asWritten';
  return (runtime.mode === 'local' || runtime.providers?.local) && !runtime.remoteTools
    ? 'none'
    : 'asWritten';
}

const NETWORK_NOTES: Record<RuntimeNetwork, string | undefined> = {
  public: "This page's keys reach public hosts only.",
  asWritten: undefined,
  none: 'Remote tools off: no host reached.',
};

/** What the studio does with the Network section on `runtime`; nothing when it runs as written. */
export function studioNetworkNote(runtime: NetworkRuntime): string | undefined {
  return NETWORK_NOTES[runtimeNetwork(runtime)];
}

/** What lent keys refuse after a remote read; nothing when the profile's own setting runs. */
export function studioTaintNote(on: StudioRunsOn): string | undefined {
  const gate = on.mode === 'demo' ? on.keys.holds.afterRemoteRead : 'off';
  if (gate === 'off') return undefined;
  const refused = gate === 'write' ? 'writes' : 'destructive calls';
  return `This page's keys refuse ${refused} after a remote read. Stricter settings hold.`;
}

/** The stricter of two gates. */
function stricterGate(a: TaintGate | undefined, b: TaintGate): TaintGate {
  return TAINT_GATES.indexOf(a ?? 'off') > TAINT_GATES.indexOf(b) ? (a as TaintGate) : b;
}

/** `guardrails` held to what lent keys refuse after a remote read. */
function withHeldTaint<G extends { taint?: { afterRemoteRead?: TaintGate } }>(
  guardrails: G,
  runtime: StudioRuntime,
): G {
  if (runtime.mode !== 'demo' || runtime.keys.holds.afterRemoteRead === 'off') return guardrails;
  const afterRemoteRead = stricterGate(
    guardrails.taint?.afterRemoteRead,
    runtime.keys.holds.afterRemoteRead,
  );
  if (afterRemoteRead === guardrails.taint?.afterRemoteRead) return guardrails;
  return { ...guardrails, taint: { ...guardrails.taint, afterRemoteRead } };
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
  // A speech, decision or embedding profile calls no tools: no network or taint hold governs it.
  if (def.type === 'speech' || def.type === 'decision' || def.type === 'embedding') return def;
  // A host runs one tool per call, so a turn never reads before it acts; the kernel refuses taint there.
  if (def.type === 'host') {
    return {
      ...def,
      guardrails: runtimeGuardrails(def.guardrails ?? {}, runtime),
    };
  }
  return {
    ...withLentCompression(def, runtime),
    guardrails: withHeldTaint(runtimeGuardrails(def.guardrails ?? {}, runtime), runtime),
  };
}

/** A Live profile on lent keys runs with the compression sizes the editor shows for them. */
function withLentCompression<D extends ProfileDefinition>(def: D, runtime: StudioRuntime): D {
  if (def.type !== 'live' || runtime.mode !== 'demo') return def;
  const compression = def.live?.contextCompression;
  if (!compression) return def;
  const sizes = lentCompression(runtime.keys, {
    triggerTokens: compression.triggerTokens,
    targetTokens: compression.slidingWindow.targetTokens,
  });
  return {
    ...def,
    live: {
      ...def.live,
      contextCompression: {
        ...compression,
        triggerTokens: sizes.triggerTokens,
        slidingWindow: { ...compression.slidingWindow, targetTokens: sizes.targetTokens },
      },
    },
  };
}

/**
 * `def` with the table compiled for each detector's patterns, here where the draft runs: a table
 * a browser sent is never trusted, since compiling is what refuses a pattern that could hang on
 * hostile text. The compiler loads only for a draft that has patterns.
 */
export async function withCompiledPatterns<D extends ProfileDefinition>(def: D): Promise<D> {
  if (!hasPatterns(def)) return def;
  const { compileDetect } = await import('@theoremjs/agents/guardrails/compile');
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
  const { slowPatternProblem } = await import('@theoremjs/agents/guardrails/compile');
  for (const { tool, side, source } of found) {
    const slow = slowPatternProblem(source);
    if (slow) {
      // labels-exempt: builder diagnostic
      throw new TheoremError('request', `${tool}: the pattern /${source}/ in its ${side} schema ${slow}`);
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

/**
 * `work` on a draft a request carries: the sender wrote the draft, so a draft the kernel refuses is
 * a bad request (`request`), not the host's configuration (`config`).
 */
function asDraft<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    if (err instanceof TheoremError && err.kind === 'config') {
      throw new TheoremError('request', err.message, { cause: err });
    }
    throw err;
  }
}

/** `defineProfile` for a draft a request carries. */
export const defineDraft = ((definition: ProfileDefinition) =>
  asDraft(() => defineProfile(definition as never))) as typeof defineProfile;

/** Registers the draft's tools, schema, and profile into `scope`, as the runtime runs it. */
async function registerDraft(
  scope: KernelScope,
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: StudioRuntime,
): Promise<Profile> {
  if (studioKeySlots(profile).length > STUDIO_KEY_SLOT_CAP) {
    throw new TheoremError('request', 'The studio supports up to 32 key slots.'); // labels-exempt: builder diagnostic
  }
  await refuseSlowSchemaPatterns(customTools);
  const defined = defineDraft(
    runtimeProfileDefinition(await withCompiledPatterns(profile), runtime),
  );
  if (defined.type !== 'host') {
    for (const binding of Object.values(defined.models)) {
      const violation = modelBindingViolation(
        {
          profileType: defined.type,
          protocol: binding.protocol,
          provider: binding.provider,
          definition: scope.providers.require(binding.provider, binding.apiId).definition.id,
          apiId: binding.apiId,
          decision: defined.type === 'decision',
          builtInTools: 'builtInTools' in binding ? (binding.builtInTools ?? []) : [],
        },
        runtime,
      );
      if (violation) throw new TheoremError('request', violation.message); // labels-exempt: builder connection diagnostic
    }
  }
  // why: Registering checks each binding's options and the tools and schemas it names, all the sender's.
  return asDraft(() => registerDefined(scope, defined, customTools, structured, runtime.toolHandlers));
}

/** Registers a draft's tools and schema, then its profile, into `scope`. */
export function registerDefined(
  scope: KernelScope,
  profile: Profile,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  handlers?: StudioToolHandlers,
): Profile {
  registerStudioTools(scope.tools, customTools, handlers);
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
      defineDraft(await withCompiledPatterns(draft.profile)),
      draft.customTools,
      draft.structured,
    );
  }
  return { scope, profile };
}
