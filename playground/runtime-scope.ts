/**
 * Playground drafts, each run on a kernel scope of its own. Two visitors can
 * name the same profile, tool, or schema without either one seeing the other's.
 */
import {
  createKernelScope,
  createProvider,
  defineProfile,
  type KernelScope,
  type Profile,
  type ProfileDefinition,
  TheoremError,
} from '../mod.ts';
import type { ResolveHost } from '../src/guardrails/network.ts';
import type { TaintGate } from '../src/guardrails/types.ts';
import type { AgentCall, AgentCallHook, ModelProvider } from '../src/kernel/types.ts';
import type { CreateProviderOptions } from '../src/providers/create-provider.ts';
import { PLAYGROUND_KEY_SLOT_CAP, playgroundKeySlots } from './browser-connection.ts';
import { modelBindingViolation } from './policy.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { registerPlaygroundTools } from './tools.ts';

export interface PlaygroundRuntime {
  mode: 'demo' | 'byok' | 'local';
  providers?: CreateProviderOptions;
  provider?: (profile: Profile, model?: string) => ModelProvider;
  resolveHost?: ResolveHost;
  remoteTools?: boolean;
  /** Before each agent tool call runs its agent: return `refuse` to stop it. */
  onAgentCall?: (
    call: AgentCall,
  ) => { refuse: string } | void | Promise<{ refuse: string } | void>;
}

/** The provider a profile's turn runs on: the runtime's own, or one from its vault. */
export function runtimeProvider(
  runtime: PlaygroundRuntime,
  profile: Profile,
  model?: string,
): ModelProvider {
  return (
    runtime.provider?.(profile, model) ??
    createProvider(profile, runtime.providers ?? {}, model)
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
    return { provider: runtimeProvider(runtime, scope.profiles.get(call.profile)) };
  };
}

/**
 * Drops the draft's network exemptions. They are for the host the profile is
 * exported to; the playground's own server reaches public hosts only.
 */
function withoutNetworkExemptions<G extends { network?: unknown }>(guardrails: G): G {
  return { ...guardrails, network: undefined };
}

/**
 * Once a turn has read a remote tool's result, a destructive call is refused: fetched text can't
 * steer the agent into deleting or overwriting. A draft that asks for stricter keeps it.
 */
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
  return runtime.mode === 'demo'
    ? withoutNetworkExemptions(guardrails)
    : (runtime.mode === 'local' || runtime.providers?.local) && !runtime.remoteTools
      ? { ...guardrails, network: { allowedSchemes: [] } }
      : guardrails;
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

/** Registers the draft's tools, schema, and profile into `scope`. */
function registerDraft(
  scope: KernelScope,
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: PlaygroundRuntime,
): Profile {
  if (playgroundKeySlots(profile).length > PLAYGROUND_KEY_SLOT_CAP) {
    throw new TheoremError('config', 'The playground supports up to 32 key slots.'); // lexicon-exempt: builder diagnostic
  }
  registerPlaygroundTools(scope.tools, customTools);
  if (structured && profile.type !== 'live') {
    scope.schemas.register(structured.id, structured.spec);
  }
  const defined = defineProfile(runtimeProfileDefinition(profile, runtime));
  if (defined.type !== 'host') {
    for (const binding of Object.values(defined.models)) {
      const violation = modelBindingViolation(
        {
          ...binding,
          builtInTools: 'builtInTools' in binding ? (binding.builtInTools ?? []) : [],
        },
        runtime.mode,
      );
      if (violation) throw new TheoremError('config', violation.message); // lexicon-exempt: builder connection diagnostic
    }
  }
  scope.profiles.register(defined);
  return defined;
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
export function playgroundScope(
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: PlaygroundRuntime,
  dependencies: readonly PlaygroundDependency[] = [],
): { scope: KernelScope; profile: Profile } {
  const scope = createKernelScope();
  for (const dependency of dependencies) {
    registerDraft(scope, dependency.profile, dependency.customTools, dependency.structured, runtime);
  }
  return {
    scope,
    profile: registerDraft(scope, profile, customTools, structured, runtime),
  };
}
