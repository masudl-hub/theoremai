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
import type { ResolveHost } from '../src/guardrails/network.ts';
import type { TaintGate } from '../src/guardrails/types.ts';
import type { ModelProvider } from '../src/kernel/types.ts';
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
  public: "The playground's server reaches public hosts only.",
  asWritten: 'Runs from this browser keep these rules as written.',
  none: 'Remote tools are off, so tools reach no host.',
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
  "Playground runs refuse a destructive call once a turn has read a remote tool's result; a stricter setting is kept.";

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

/**
 * A new scope holding one request's draft, and the profile to run on it. Never cache or share it:
 * the scope also holds MCP sessions, and a shared one would hand a keyless server's session to
 * every visitor and keep it past the request.
 */
export function playgroundScope(
  profile: ProfileDefinition,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  runtime: PlaygroundRuntime,
): { scope: KernelScope; profile: Profile } {
  const scope = createKernelScope();
  return {
    scope,
    profile: registerDraft(scope, profile, customTools, structured, runtime),
  };
}

export { PLAYGROUND_TAINT_NOTE, playgroundNetworkNote };
