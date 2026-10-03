import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import type { ToolOrigin } from '../../guardrails/types.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import { interactionPartSchema } from '../turn-events.ts';
import type { Profile, ProfileId, TurnEvent, TurnEventOf, TurnTokens } from '../types.ts';
import { findLast } from '../util/find-last.ts';
import { profileToolAllow } from './resolve.ts';
import type {
  AgentToolDef,
  AgentToolInput,
  AgentToolOutput,
  RegisteredAgentTool,
  RegisteredTool,
  ToolFailure,
} from './types.ts';

/** How one agent tool call settled, with what the called agent used. */
type AgentRun =
  | { output: AgentToolOutput; tokens?: TurnTokens }
  | { failure: ToolFailure; tokens?: TurnTokens };

/** Runs agent tool calls for one turn, which supplies the scope, provider and hook. */
interface AgentCaller {
  run(call: {
    tool: RegisteredAgentTool;
    callId: string;
    input: AgentToolInput;
    caller: Profile;
    /** The call's `execute_tool` span; the agent's turn opens under it. */
    span?: SpanHandle;
    signal?: AbortSignal;
  }): AsyncGenerator<TurnEvent, AgentRun>;
}

/** A call that settled without a reply; the model reads `failure`. */
class AgentCallFailed extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.message);
  }
}

/** The agents an agent tool can run: each has a turn that takes text. */
const AGENT_TOOL_TYPES: ReadonlySet<Profile['type']> = new Set(['text', 'image', 'speech']);

const agentToolInput: z.ZodType<AgentToolInput> = z.object({
  text: z.string().min(1),
});

const agentToolOutput: z.ZodType<AgentToolOutput> = z.object({
  text: z.string(),
  structured: z.unknown().optional(),
  parts: z.array(interactionPartSchema).optional(),
});

function profileTakesText(profile: Profile): boolean {
  if (profile.type === 'speech') return true;
  return (profile.type === 'text' || profile.type === 'image') && profile.inputs.text !== false;
}

/** A tool that can stop the turn on a gate: a gate inside the called agent has no one to answer it. */
function toolCanGate(tool: RegisteredTool): boolean {
  if (tool.type === 'builtin') return false;
  if (tool.permission !== 'auto') return true;
  return (
    'auth' in tool && tool.auth !== undefined && tool.auth.onUnauthenticated !== 'report_to_model'
  );
}

/** Why `profile` can't be run by an agent tool, or `undefined` when it can. */
function agentProfileProblem(
  profile: Profile,
  find: (name: string) => RegisteredTool | undefined,
): string | undefined {
  if (!AGENT_TOOL_TYPES.has(profile.type)) {
    return `it is a ${profile.type} profile; an agent tool runs a text, image or speech profile`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!profileTakesText(profile)) return 'it does not take text'; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  for (const id of profileToolAllow(profile)) {
    const tool = find(id);
    if (!tool) return `its tool '${id}' is not registered; register it first`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    if (toolCanGate(tool)) {
      return `its tool '${id}' can stop on a gate; give it permission 'auto' and no sign-in`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  return undefined;
}

function assertAgentTool(
  def: AgentToolDef,
  findProfile: (id: ProfileId) => Profile | undefined,
  findTool: (name: string) => RegisteredTool | undefined,
): void {
  const tag = `Agent tool "${def.name}"`; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const max = def.maxCallsPerTurn;
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
    throw new TheoremError('config', `${tag}: maxCallsPerTurn must be a whole number above 0`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const profile = findProfile(def.profile);
  if (!profile) {
    throw new TheoremError(
      'config',
      `${tag}: profile '${def.profile}' must be registered before the tool`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const problem = agentProfileProblem(profile, findTool);
  if (problem) {
    throw new TheoremError('config', `${tag} can't run '${def.profile}': ${problem}`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

/** An agent with no tools of its own read only what it was sent; one with tools may have read outside content. */
function agentToolOrigin(profile: Profile | undefined): ToolOrigin {
  if (!profile) return 'delegated';
  const builtins =
    'models' in profile
      ? Object.values(profile.models).some((binding) => (binding.builtInTools?.length ?? 0) > 0)
      : false;
  return profileToolAllow(profile).length === 0 && !builtins ? 'local' : 'delegated';
}

/** The called agent's reply: its text, its last structured reply, and its media as parts. */
function agentToolOutputOf(events: readonly TurnEvent[]): AgentToolOutput {
  const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
  const structured = findLast(
    events,
    (e): e is TurnEventOf<'structured'> => e.type === 'structured',
  )?.structured;
  const parts = events.flatMap((e) =>
    e.type === 'media'
      ? [
          {
            type: e.media.mimeType.startsWith('audio/') ? ('audio' as const) : ('image' as const),
            mimeType: e.media.mimeType,
            data: e.media.data,
          },
        ]
      : [],
  );
  return {
    text,
    ...(structured === undefined ? {} : { structured }),
    ...(parts.length > 0 ? { parts } : {}),
  };
}

function normalizeAgent(
  def: AgentToolDef,
  findProfile: (id: ProfileId) => Profile | undefined,
  findTool: (name: string) => RegisteredTool | undefined,
  schemas: { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> },
): RegisteredAgentTool {
  assertAgentTool(def, findProfile, findTool);
  return { ...def, type: 'agent', input: agentToolInput, output: agentToolOutput, ...schemas };
}

export type { AgentCaller, AgentRun };
export {
  AgentCallFailed,
  agentProfileProblem,
  agentToolInput,
  agentToolOrigin,
  agentToolOutput,
  agentToolOutputOf,
  normalizeAgent,
};
