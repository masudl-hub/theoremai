import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import type { ToolOrigin } from '../../guardrails/types.ts';
import type { SpanHandle } from '../../observability/trace-span.ts';
import { interactionPartSchema, keptReply, sourceSchema } from '../turn-events.ts';
import type {
  Profile,
  ProfileId,
  ProfileInputsSpec,
  TurnEvent,
  TurnEventOf,
  TurnTokens,
} from '../types.ts';
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

/** Runs agent tool calls for one turn, which supplies the scope, provider, and hook. */
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

// why: Bytes that are not base64, or a text of only spaces, would be refused inside the called turn as the host's error and end the caller's turn; checked here, the model reads a failed call.
const textInput = z.string().regex(/\S/);

const blobInput = z.strictObject({
  mimeType: z.string(),
  data: z.base64(),
  name: z.string().optional(),
});

const mediaRefInput = z.strictObject({
  mimeType: z.string(),
  uri: z.string(),
  name: z.string().optional(),
});

const speechInput = z.strictObject({
  voice: z.string().optional(),
  style: z.string().optional(),
  speed: z.number().positive().optional(),
});

/** One choice per declared slot; a slot or a value the profile does not declare is refused. */
function slotsInput(slots: Record<string, string[]>) {
  return z.strictObject(
    Object.fromEntries(
      Object.entries(slots).map(([slot, choices]) => [slot, z.enum(choices).optional()]),
    ),
  );
}

/** The fields an agent tool's input can carry to the called agent; a host field takes none of these names. */
const AGENT_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'attachments',
  'voice',
  'slots',
  'speech',
]);

/**
 * What the model sent, split into what goes to the called agent and what only the host reads.
 *
 * why: A host field is the host's own word for something (an id it resolves); the called profile does not take it, so it never reaches the agent's turn.
 */
function splitHostInput(
  tool: Pick<AgentToolDef, 'hostFields'>,
  input: AgentToolInput,
): { sent: AgentToolInput; hostInput?: Record<string, unknown> } {
  if (!tool.hostFields) return { sent: input };
  const all: Record<string, unknown> = { ...input };
  const hostInput: Record<string, unknown> = {};
  for (const field of Object.keys(tool.hostFields)) {
    if (all[field] !== undefined) hostInput[field] = all[field];
  }
  const { text, attachments, voice, slots, speech } = input;
  return {
    sent: {
      text,
      ...(attachments ? { attachments } : {}),
      ...(voice ? { voice } : {}),
      ...(slots ? { slots } : {}),
      ...(speech ? { speech } : {}),
    },
    hostInput,
  };
}

/**
 * The input of an agent tool that runs `agent`: text, and each channel the
 * profile's `inputs` declares. Anything else is refused, never dropped. The
 * called turn's own ingress checks MIME types and sizes.
 */
function agentToolInputFor(
  agent: Pick<Profile, 'type'> & {
    inputs?: Pick<ProfileInputsSpec, 'attachments' | 'voice' | 'slots'>;
  },
  tool?: Pick<AgentToolDef, 'name' | 'fieldText' | 'hostFields' | 'hostOnly'>,
): z.ZodType<AgentToolInput> {
  const { inputs } = agent;
  const shape: Record<string, z.ZodType> = { text: textInput };
  if (inputs?.attachments) {
    shape.attachments = z.array(z.union([blobInput, mediaRefInput])).optional();
  }
  if (inputs?.voice) shape.voice = z.array(blobInput).optional();
  if (inputs?.slots) shape.slots = slotsInput(inputs.slots).optional();
  if (agent.type === 'speech') shape.speech = speechInput.optional();
  for (const channel of tool?.hostOnly ?? []) {
    if (!shape[channel]) {
      throw new TheoremError(
        'config',
        `Tool '${tool?.name}' keeps '${channel}' for the host, which its profile does not take`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    delete shape[channel];
  }
  for (const [field, text] of Object.entries(tool?.fieldText ?? {})) {
    const schema = shape[field];
    if (!schema) {
      throw new TheoremError(
        'config',
        `Tool '${tool?.name}' describes '${field}', which its profile does not take`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    shape[field] = schema.describe(text);
  }
  for (const [field, schema] of Object.entries(tool?.hostFields ?? {})) {
    if (AGENT_INPUT_FIELDS.has(field)) {
      throw new TheoremError(
        'config',
        `Tool '${tool?.name}' declares the host field '${field}', which is a field of every agent tool`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    shape[field] = schema;
  }
  // why: The shape is built key by key from the profile, which zod cannot type; each key is an `AgentToolInput` field.
  return z.strictObject(shape) as unknown as z.ZodType<AgentToolInput>;
}

const agentToolOutput: z.ZodType<AgentToolOutput> = z.object({
  text: z.string().optional(),
  structured: z.unknown().optional(),
  removed: z
    .array(z.object({ path: z.string(), reason: z.string(), item: z.unknown() }))
    .optional(),
  parts: z.array(interactionPartSchema).optional(),
  sources: z.array(sourceSchema).optional(),
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
    'auth' in tool && tool.auth !== undefined && (tool.auth.onUnauthenticated ?? 'gate') === 'gate'
  );
}

/** Why `profile` can't be run by an agent tool, or `undefined` when it can. */
function agentProfileProblem(
  profile: Profile,
  find: (name: string) => RegisteredTool | undefined,
): string | undefined {
  if (!AGENT_TOOL_TYPES.has(profile.type)) {
    return `it is a ${profile.type} profile; an agent tool runs a text, image, or speech profile`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (!profileTakesText(profile)) return 'it does not take text'; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  for (const id of profileToolAllow(profile)) {
    const tool = find(id);
    if (!tool) return `its tool '${id}' is not registered; register it first`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    if (toolCanGate(tool)) {
      return `its tool '${id}' can stop on a gate; give it permission 'auto' and no sign-in`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
  }
  return undefined;
}

/** The profile an agent tool runs; throws `config` when the tool can't run it. */
function agentToolProfile(
  def: AgentToolDef,
  findProfile: (id: ProfileId) => Profile | undefined,
  findTool: (name: string) => RegisteredTool | undefined,
): Profile {
  const tag = `Agent tool "${def.name}"`; // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  const max = def.maxCallsPerTurn;
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
    throw new TheoremError('config', `${tag}: maxCallsPerTurn must be a whole number above 0`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  const profile = findProfile(def.profile);
  if (!profile) {
    throw new TheoremError(
      'config',
      `${tag}: profile '${def.profile}' must be registered before the tool`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  const problem = agentProfileProblem(profile, findTool);
  if (problem) {
    throw new TheoremError('config', `${tag} can't run '${def.profile}': ${problem}`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return profile;
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

/**
 * The called agent's reply: its text or its last structured reply, its media as parts, and what it cited.
 *
 * why: A structured reply's text is the same JSON as a string, so returning both would have the caller's model read the answer twice.
 */
function agentToolOutputOf(turn: readonly TurnEvent[]): AgentToolOutput {
  const events = keptReply(turn);
  const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
  const reply = findLast(events, (e): e is TurnEventOf<'structured'> => e.type === 'structured');
  const structured = reply?.structured;
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
  const sources = events.flatMap((e) => (e.type === 'citation' ? e.sources : []));
  return {
    ...(structured === undefined ? { text } : { structured }),
    ...(reply?.removed?.length ? { removed: reply.removed } : {}),
    ...(parts.length > 0 ? { parts } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
}

function normalizeAgent(
  def: AgentToolDef,
  input: z.ZodType<AgentToolInput>,
  schemas: { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> },
): RegisteredAgentTool {
  return {
    ...def,
    type: 'agent',
    input,
    output: agentToolOutput,
    sources: (output) => output.sources ?? [],
    ...schemas,
  };
}

export type { AgentCaller, AgentRun };
export {
  AgentCallFailed,
  agentProfileProblem,
  agentToolInputFor,
  agentToolOrigin,
  agentToolOutput,
  agentToolOutputOf,
  agentToolProfile,
  normalizeAgent,
  splitHostInput,
};
