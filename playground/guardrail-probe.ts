/**
 * Sends one text across one guardrail boundary of a draft and reports what its
 * guardrails did. The turn is the kernel's own on a scripted model, so every
 * check is the one a real turn runs, on the draft's guardrails as written, and
 * no model or host is called.
 *
 * @module
 */
import type {
  ModelProvider,
  Profile,
  ProfileDefinition,
  TraceRecord,
  TurnEvent,
  TurnInput,
} from '../mod.ts';
import { TheoremError } from '../mod.ts';
import type { GuardrailEvent } from '../src/guardrails/event-schemas.ts';
import { TOOL_RULES } from '../src/guardrails/rules.ts';
import type { ErrorKind } from '../src/guardrails/theorem-error.ts';
import type { ProviderEvent } from '../src/kernel/turn-events.ts';
import type { ProviderCompleteRequest } from '../src/kernel/types.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { agentCallHook, type PlaygroundDependency, writtenScope } from './runtime-scope.ts';

/** Where a probe's text enters the turn. */
export const PROBE_BOUNDARIES = [
  'user',
  'history',
  'system',
  'tool_result_local',
  'tool_result_remote',
  'tool_arguments',
  'reply',
  'thought',
] as const;
/** One of {@linkcode PROBE_BOUNDARIES}. */
export type ProbeBoundary = (typeof PROBE_BOUNDARIES)[number];

/** A boundary as the tester tells it. */
export interface ProbeBoundaryNote {
  label: string;
  /** What crosses the boundary. */
  note: string;
  /** When in a turn the kernel reads it. */
  when: string;
  /** What the kernel does with what it finds there. */
  checks: string;
}

/** Each boundary: its name, what crosses it, when the kernel reads it and what it does there. */
export const PROBE_BOUNDARY_NOTES: Record<ProbeBoundary, ProbeBoundaryNote> = {
  user: {
    label: 'User message',
    note: 'What a person types into the chat.',
    when: 'Before the first model call of the turn.',
    checks:
      'Injection phrasing and sensitive data are replaced with a placeholder (detect). The model reads the rest, fenced as user data.',
  },
  history: {
    label: 'Earlier message',
    note: 'A user message the host replays from an earlier turn.',
    when: 'Before the first model call, on every turn that replays it.',
    checks: 'Read as a new user message is: injection phrasing and sensitive data are replaced.',
  },
  system: {
    label: 'Host system text',
    note: 'Text the host adds to the system prompt for one turn, such as retrieved documents.',
    when: 'Before the first model call of the turn.',
    checks:
      'Read as assembled, not trusted: injection phrasing and sensitive data are replaced. The profile’s own system prompt is trusted and not read.',
  },
  tool_result_local: {
    label: 'Local tool result',
    note: 'What one of the host’s own functions returns.',
    when: 'When the tool returns, before the model reads the result.',
    checks: 'Injection phrasing and sensitive data are replaced in the result the model reads.',
  },
  tool_result_remote: {
    label: 'Remote tool result',
    note: 'What a tool returns from outside the host: a web page, an MCP server, another agent. It runs here as another agent’s reply, and the model then makes a destructive call.',
    when: 'When the tool returns, and again at each call the model makes after it.',
    checks:
      'Replaced as a local result is, fenced as tool data, and read for directives (a claim of authority, an order, a callable tool’s name), which are reported and never removed. Every later call is reported, and refused where taint.afterRemoteRead says.',
  },
  tool_arguments: {
    label: 'Tool arguments',
    note: 'What the model sends to a tool.',
    when: 'After the model asks for the call, before the tool runs.',
    checks: 'A credential in the arguments is reported. The call still runs.',
  },
  reply: {
    label: 'Model reply',
    note: 'What the model says to the user, streamed.',
    when: 'As it streams: text is held only while it could still be the start of a match.',
    checks:
      'Sensitive data, injection phrasing, the canary and a private prompt echo get the action detect sets for a reply. The egress checks block the user-data fence, an image to a URL the model was not given, and a link to one where links is on.',
  },
  thought: {
    label: 'Model thought',
    note: 'The model’s reasoning, where the host shows it.',
    when: 'As it streams, where the profile streams thoughts.',
    checks:
      'Never stops the turn. The canary and a private prompt echo get the action detect sets for a thought. An image, a link (where links is on) and the user-data fence are left out of what the host shows. Sensitive data and injection phrasing are not read.',
  },
};

/** The longest text a probe carries. */
export const PROBE_TEXT_LIMIT = 8000;

export interface GuardrailProbe {
  boundary: ProbeBoundary;
  text: string;
}

/**
 * What the guardrails did with a probed text, mildest first. `flagged` is a
 * report that changed nothing; a call made after a remote read is reported
 * whatever was read, so that report is `taint` and no status.
 */
export const PROBE_STATUSES = ['passed', 'flagged', 'redacted', 'blocked'] as const;
/** One of {@linkcode PROBE_STATUSES}. */
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export interface GuardrailProbeResult {
  /** The strongest thing a guardrail did with the text. */
  status: ProbeStatus;
  /** Every guardrail decision of the turn, in order. */
  guardrails: GuardrailEvent[];
  /**
   * The text past its boundary: what the model read (for `system`, the whole
   * system prompt), or for `reply` and `thought` what the user got. Absent
   * when nothing went on.
   */
  passed?: string;
  /**
   * Set when a call was made after a remote read: `steered` when what was read
   * also looked like instructions to the agent, else `tainted`.
   */
  taint?: 'tainted' | 'steered';
  /** The turn's failure, when it ended in one. */
  refused?: { kind: ErrorKind; message?: string };
  /** The turn's trace records, as the kernel wrote them. */
  traces: TraceRecord[];
}

const LOCAL_TOOL = 'guardrail_probe_read';
const REMOTE_TOOL = 'guardrail_probe_fetch';
const SEND_TOOL = 'guardrail_probe_send';
const ACT_TOOL = 'guardrail_probe_delete';
const REMOTE_AGENT = 'guardrail-probe.remote';
/** The reply's deltas, in characters: short enough that a pattern spans several. */
const REPLY_CHUNK = 7;

const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
};

function probeTool(
  name: string,
  access: ToolRegistration['access'],
  stub?: Record<string, unknown>,
): ToolRegistration {
  return {
    type: 'function',
    name,
    description: 'A guardrail probe.',
    category: 'probe',
    access,
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    inputSchema: TEXT_SCHEMA,
    outputSchema: TEXT_SCHEMA,
    ...(stub ? { stubResponse: stub } : {}),
  };
}

/**
 * An agent whose reply is the probe's text. It has a tool of its own, so the
 * kernel reads its reply as remote content, as it reads an HTTP or MCP result.
 */
function remoteAgent(profile: TextProfile): PlaygroundDependency {
  const { outputs: _outputs, turnBehaviour: _turnBehaviour, ...rest } = unobserved(profile);
  return {
    profile: {
      ...rest,
      id: REMOTE_AGENT,
      identity: { handle: 'probe', system: '' },
      tools: { allow: [LOCAL_TOOL] },
      guardrails: { detect: 'ignore' },
    },
    customTools: [probeTool(LOCAL_TOOL, 'read-only')],
  };
}

type TextProfile = Extract<ProfileDefinition, { type: 'text' }>;

/** A probe's trace goes to its result alone: its scope has none of the draft's destinations. */
function unobserved(profile: TextProfile): TextProfile {
  const { observability: _observability, ...rest } = profile;
  return rest;
}

/** The failures that are a guardrail's doing; any other is the probe's own. */
const REFUSALS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['safety', 'blocked']);

/** The draft with the probe's tools beside its own. */
function probedDraft(
  profile: TextProfile,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  text: string,
): PlaygroundDependency {
  const tools: ToolRegistration[] = [
    probeTool(LOCAL_TOOL, 'read-only', { text }),
    probeTool(SEND_TOOL, 'read-write'),
    probeTool(ACT_TOOL, 'destructive'),
    {
      type: 'agent',
      name: REMOTE_TOOL,
      description: 'A guardrail probe.',
      category: 'probe',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      profile: REMOTE_AGENT,
      inputSchema: TEXT_SCHEMA,
      outputSchema: TEXT_SCHEMA,
    },
  ];
  return {
    profile: {
      ...unobserved(profile),
      tools: {
        ...profile.tools,
        allow: [...(profile.tools?.allow ?? []), ...tools.map((tool) => tool.name)],
      },
    },
    customTools: [...customTools, ...tools],
    structured,
  };
}

function call(name: string, args: Record<string, unknown>): ProviderEvent {
  return { type: 'tool', tool: { name, arguments: args, callId: `probe_${name}` } };
}

function chunks(text: string): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let at = 0; at < chars.length; at += REPLY_CHUNK) {
    out.push(chars.slice(at, at + REPLY_CHUNK).join(''));
  }
  return out;
}

/** What the scripted model says at each of its steps; past them it says `ok`. */
function script({ boundary, text }: GuardrailProbe): ProviderEvent[][] {
  switch (boundary) {
    case 'tool_result_local':
      return [[call(LOCAL_TOOL, {})]];
    // The call after the read is the one `taint.afterRemoteRead` decides.
    case 'tool_result_remote':
      return [[call(REMOTE_TOOL, { text: 'read' })], [call(ACT_TOOL, {})]];
    case 'tool_arguments':
      return [[call(SEND_TOOL, { text })]];
    case 'reply':
      return [chunks(text).map((chunk) => ({ type: 'text', text: chunk }))];
    case 'thought':
      return [[{ type: 'thought', text }]];
    default:
      return [];
  }
}

function scripted(steps: ProviderEvent[][], seen: ProviderCompleteRequest[]): ModelProvider {
  let step = 0;
  return {
    async *complete(req) {
      seen.push(req);
      const events = steps[step] ?? [{ type: 'text', text: 'ok' }];
      step += 1;
      await Promise.resolve();
      yield* events;
    },
  };
}

function turnInput({ boundary, text }: GuardrailProbe): TurnInput {
  if (boundary === 'user') return { text };
  if (boundary === 'history') {
    return {
      text: 'Go on.',
      history: [
        { role: 'user', content: text },
        { role: 'assistant', content: 'ok' },
      ],
    };
  }
  return { text: 'Run the probe.' };
}

function readBack(events: readonly TurnEvent[], name: string): string | undefined {
  for (const event of events) {
    if (event.type !== 'tool' || event.tool.name !== name) continue;
    if ('readBack' in event.tool && event.tool.readBack !== undefined) return event.tool.readBack;
  }
  return undefined;
}

function said(events: readonly TurnEvent[], type: 'text' | 'thought'): string | undefined {
  const text = events.flatMap((event) => (event.type === type ? [event.text] : [])).join('');
  return text === '' ? undefined : text;
}

/** The probe's text past its boundary, from what the model was sent and the host got. */
function passed(
  boundary: ProbeBoundary,
  events: readonly TurnEvent[],
  seen: readonly ProviderCompleteRequest[],
): string | undefined {
  const [first] = seen;
  const users = (first?.history ?? []).filter((message) => message.role === 'user');
  switch (boundary) {
    case 'user':
      return users.at(-1)?.content;
    case 'history':
      return users[0]?.content;
    case 'system':
      return first?.system;
    case 'tool_result_local':
      return readBack(events, LOCAL_TOOL);
    case 'tool_result_remote':
      return readBack(events, REMOTE_TOOL);
    case 'tool_arguments':
      return readBack(events, SEND_TOOL) === undefined ? undefined : seenArguments(events);
    case 'reply':
      return said(events, 'text');
    case 'thought':
      return said(events, 'thought');
  }
}

function seenArguments(events: readonly TurnEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'tool' && event.tool.name === SEND_TOOL && 'arguments' in event.tool) {
      return JSON.stringify(event.tool.arguments);
    }
  }
  return undefined;
}

/** What a probe is run on: a draft's compiled agent and the agents it names. */
export interface GuardrailProbeDraft extends PlaygroundDependency {
  dependencies?: readonly PlaygroundDependency[];
}

function withoutHeaders(tools: readonly ToolRegistration[]): ToolRegistration[] {
  return tools.map((tool) => {
    if (!('headers' in tool)) return tool;
    const { headers: _headers, ...rest } = tool;
    return rest;
  });
}

/**
 * The draft as a probe is sent it: a probe calls none of the draft's tools,
 * so the headers they would send, where a key may sit, stay behind.
 */
export function probeDraft(draft: GuardrailProbeDraft): GuardrailProbeDraft {
  return {
    profile: draft.profile,
    customTools: withoutHeaders(draft.customTools),
    ...(draft.structured ? { structured: draft.structured } : {}),
    dependencies: (draft.dependencies ?? []).map((dependency) => ({
      ...dependency,
      customTools: withoutHeaders(dependency.customTools),
    })),
  };
}

/** Why `profile` can't be probed, or undefined when it can. */
export function probeRefusal(profile: ProfileDefinition): string | undefined {
  return profile.type === 'text' ? undefined : 'Guardrail tests run on text agents.';
}

function probeStatus(guardrails: readonly GuardrailEvent[], refused: boolean): ProbeStatus {
  const did = (action: GuardrailEvent['action']) =>
    guardrails.some((event) => event.action === action);
  if (refused || did('block')) return 'blocked';
  if (did('redact')) return 'redacted';
  const reported = guardrails.some(
    (event) =>
      event.action === 'flag' &&
      event.hits.some(
        (hit) => hit.rule !== TOOL_RULES.taintedTurn && hit.rule !== TOOL_RULES.steeredTurn,
      ),
  );
  return reported ? 'flagged' : 'passed';
}

/** Runs `probe` on the draft and reports what its guardrails did. */
export async function runGuardrailProbe(args: {
  profile: ProfileDefinition;
  customTools: readonly ToolRegistration[];
  structured?: StructuredRegistration;
  dependencies?: readonly PlaygroundDependency[];
  probe: GuardrailProbe;
  signal?: AbortSignal;
}): Promise<GuardrailProbeResult> {
  const { probe } = args;
  const refusal = probeRefusal(args.profile);
  if (refusal || args.profile.type !== 'text') {
    throw new TheoremError('request', refusal ?? ''); // lexicon-exempt: builder diagnostic
  }
  if (probe.text.length > PROBE_TEXT_LIMIT) {
    throw new TheoremError('request', `A probe is at most ${PROBE_TEXT_LIMIT} characters.`); // lexicon-exempt: builder diagnostic
  }
  const { scope, profile } = writtenScope([
    ...(args.dependencies ?? []),
    remoteAgent(args.profile),
    probedDraft(args.profile, args.customTools, args.structured, probe.text),
  ]);
  if (!profile) throw new TheoremError('request', 'No agent to probe.'); // lexicon-exempt: builder diagnostic

  const seen: ProviderCompleteRequest[] = [];
  const model = scripted(script(probe), seen);
  const remote = scripted([[{ type: 'text', text: probe.text }]], []);
  const provider = (asked: Profile): ModelProvider => (asked.id === REMOTE_AGENT ? remote : model);

  const events: TurnEvent[] = [];
  const traces: TraceRecord[] = [];
  let refused: GuardrailProbeResult['refused'];
  try {
    for await (const event of scope.runTurn(
      {
        profile: profile.id,
        input: turnInput(probe),
        ...(probe.boundary === 'system' ? { system: probe.text } : {}),
        signal: args.signal,
        onAgentCall: agentCallHook(scope, { mode: 'byok', provider }),
      },
      model,
      {
        write: (record) => {
          traces.push(record);
          return Promise.resolve();
        },
      },
    )) {
      events.push(event);
    }
  } catch (error) {
    if (!(error instanceof TheoremError && REFUSALS.has(error.kind))) throw error;
    refused = { kind: error.kind, message: error.message };
  }
  const failure = events.find((event) => event.type === 'error');
  if (failure?.type === 'error') {
    if (!REFUSALS.has(failure.errorKind)) {
      throw new TheoremError(failure.errorKind, failure.errorInternal ?? failure.error ?? ''); // lexicon-exempt: builder diagnostic
    }
    refused = { kind: failure.errorKind, message: failure.error };
  }

  const guardrails = events.flatMap((event) =>
    event.type === 'guardrail' ? [event.guardrail] : [],
  );
  const text = passed(probe.boundary, events, seen);
  const rules = new Set(guardrails.flatMap((event) => event.hits.map((hit) => hit.rule)));
  const taint = rules.has(TOOL_RULES.steeredTurn)
    ? 'steered'
    : rules.has(TOOL_RULES.taintedTurn) && 'tainted';
  return {
    status: probeStatus(guardrails, refused !== undefined),
    guardrails,
    ...(text === undefined ? {} : { passed: text }),
    ...(taint ? { taint } : {}),
    ...(refused ? { refused } : {}),
    traces,
  };
}

/** What one boundary's guardrails did with a text sent across every boundary. */
export interface GuardrailProbeAnswer extends GuardrailProbeResult {
  boundary: ProbeBoundary;
}

/** Runs `text` across every boundary of the draft, each in its own turn, in the order of {@linkcode PROBE_BOUNDARIES}. */
export function runGuardrailProbes(
  args: Omit<Parameters<typeof runGuardrailProbe>[0], 'probe'> & { text: string },
): Promise<GuardrailProbeAnswer[]> {
  const { text, ...draft } = args;
  return Promise.all(
    PROBE_BOUNDARIES.map(async (boundary) => ({
      boundary,
      ...(await runGuardrailProbe({ ...draft, probe: { boundary, text } })),
    })),
  );
}
