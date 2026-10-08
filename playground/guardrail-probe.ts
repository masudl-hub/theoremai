/**
 * Sends one text across one guardrail boundary of a draft and reports what its
 * guardrails did. The turn is the kernel's own on a scripted model, so every
 * check is the one a real turn runs, on the draft's guardrails as written, and
 * no model or host is called. A probe keeps what each hit matched: its text
 * is the builder's own sample, and its trace goes nowhere but its result.
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
import type { Boundary } from '../src/guardrails/boundaries.ts';
import {
  actionAt,
  DETECTORS,
  type DetectSpec,
  resolveDetect,
} from '../src/guardrails/detectors.ts';
import type { GuardrailEvent } from '../src/guardrails/event-schemas.ts';
import { sanitizeTurnRequestWithEvents } from '../src/guardrails/sanitize.ts';
import { TOOL_RULES } from '../src/guardrails/rules.ts';
import type { ErrorKind } from '../src/guardrails/theorem-error.ts';
import type { ProviderEvent } from '../src/kernel/turn-events.ts';
import type { ProviderCompleteRequest } from '../src/kernel/types.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import { runtimeProvider, agentCallHook, type PlaygroundDependency, writtenScope } from './runtime-scope.ts';

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

/** The kernel boundary a probe's text crosses. */
const PROBE_READS: Record<ProbeBoundary, Boundary> = {
  user: 'user',
  history: 'history',
  system: 'system',
  tool_result_local: 'tool_output_function',
  tool_result_remote: 'tool_output_agent',
  tool_arguments: 'tool_arguments_function',
  reply: 'reply',
  thought: 'thought',
};

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
      'Replaced as a local result is, fenced as tool data, and read for instructions to the agent (a claim of authority, an order, a callable tool’s name), which tool_instructions reports by default. Every later call is reported, and refused where taint.afterRemoteRead says.',
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
      'Each detector takes the action detect sets for a reply: sensitive data, injection phrasing, the canary, a private prompt echo, the user-data fence, and an image or a link to a URL the model was not given.',
  },
  thought: {
    label: 'Model thought',
    note: 'The model’s reasoning, where the host shows it.',
    when: 'As it streams, where the profile streams thoughts.',
    checks:
      'Never stops the turn. The canary, a private prompt echo, the user-data fence, and an image or a link to a URL the model was not given get the action detect sets for a thought. Sensitive data and injection phrasing are not read.',
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
function remoteAgent(profile: ToolProfile | HostProfile): PlaygroundDependency {
  // why: A host profile runs no model, so its probe agent gets a binding of its own. The scripted
  // provider answers for it, whatever it names.
  const base =
    profile.type === 'host'
      ? ({
          type: 'text',
          models: { probe: { provider: 'google', apiId: 'probe' } },
          defaultModel: 'probe',
          inputs: { text: true },
        } as const)
      : unobserved(profile);
  const { outputs: _outputs, turnBehaviour: _turnBehaviour, ...rest } = base as ToolProfile;
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

/** A profile that calls tools and writes a reply: the text and image types. */
type ToolProfile = Extract<ProfileDefinition, { type: 'text' | 'image' }>;
type SpeechProfile = Extract<ProfileDefinition, { type: 'speech' }>;
type HostProfile = Extract<ProfileDefinition, { type: 'host' }>;
type LiveProfile = Extract<ProfileDefinition, { type: 'live' }>;

/** A probe's trace goes to its result alone: its scope has none of the draft's destinations. */
function unobserved<P extends ToolProfile | SpeechProfile | HostProfile | LiveProfile>(profile: P): P {
  const { observability: _observability, ...rest } = profile;
  return rest as P;
}

/** `spec` with every detector but `key` set to ignore. */
function detectOnly(spec: DetectSpec | undefined, key: string): DetectSpec {
  // why: One action for everything covers Theorem's detectors, never a host's own.
  const blanket = key.includes('.') ? undefined : spec;
  const rule = typeof spec === 'object' ? spec[key as never] : blanket;
  const others = DETECTORS.filter((detector) => detector !== key);
  const only: Record<string, unknown> = Object.fromEntries(
    others.map((detector) => [detector, 'ignore']),
  );
  if (rule !== undefined) only[key] = rule;
  return only as DetectSpec;
}

/** `profile` reading with the detector `key` alone. */
function onlyDetector(profile: ProfileDefinition, key: string): ProfileDefinition {
  const detect = detectOnly(profile.guardrails?.detect, key);
  return { ...profile, guardrails: { ...profile.guardrails, detect } } as ProfileDefinition;
}

/** The boundaries where the detector `key` of `profile` does something with a match. */
function readBy(profile: ProfileDefinition, key: string): ProbeBoundary[] {
  const detect = resolveDetect(profile.guardrails?.detect);
  return probeBoundariesOf(profile).filter(
    (boundary) => actionAt(detect, key, boundaryRead(profile, boundary)) !== 'ignore',
  );
}

/** The kernel boundary `boundary` is for `profile`: a Live session reads its own at the two ends. */
function boundaryRead(profile: ProfileDefinition, boundary: ProbeBoundary): Boundary {
  if (profile.type !== 'live') return PROBE_READS[boundary];
  if (boundary === 'user') return 'live_user';
  return boundary === 'reply' ? 'live_reply' : PROBE_READS[boundary];
}

/** The failures that are a guardrail's doing; any other is the probe's own. */
const REFUSALS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['safety', 'blocked']);

/**
 * Whether a turn that failed with `kind` was refused by a guardrail. A block of the request
 * fails as a bad input does, so there the block already among `events` tells them apart.
 */
function refusedBy(kind: ErrorKind, events: readonly TurnEvent[]): boolean {
  if (REFUSALS.has(kind)) return true;
  return (
    kind === 'input' &&
    events.some((event) => event.type === 'guardrail' && event.guardrail.action === 'block')
  );
}

/** The draft with the probe's tools beside its own. */
function probedDraft(
  profile: ToolProfile | SpeechProfile | HostProfile | LiveProfile,
  customTools: readonly ToolRegistration[],
  structured: StructuredRegistration | undefined,
  text: string,
): PlaygroundDependency {
  if (profile.type === 'speech') {
    return {
      profile: {
        ...unobserved(profile),
        observability: { include: { guardrailMatchPreview: true } },
      },
      customTools: [],
    };
  }
  const live = profile.type === 'live';
  const tools: ToolRegistration[] = [
    probeTool(LOCAL_TOOL, 'read-only', { text }),
    probeTool(SEND_TOOL, 'read-write'),
    probeTool(ACT_TOOL, 'destructive'),
    ...(live ? [] : [remoteTool()]),
  ];
  return {
    profile: {
      ...unobserved(profile),
      // why: The probe types its text into the session, whatever the draft takes in.
      ...(profile.type === 'live'
        ? { live: { ...profile.live, ingress: { ...profile.live?.ingress, text: true } } }
        : {}),
      observability: { include: { guardrailMatchPreview: true } },
      tools: {
        ...profile.tools,
        allow: [...(profile.tools?.allow ?? []), ...tools.map((tool) => tool.name)],
      },
    } as ProfileDefinition,
    customTools: [...customTools, ...tools],
    structured,
  };
}

function remoteTool(): ToolRegistration {
  return {
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

/** The tool a host probe calls, and what it sends. */
function hostCall({ boundary, text }: GuardrailProbe): { name: string; input: unknown } {
  switch (boundary) {
    case 'tool_result_remote':
      return { name: REMOTE_TOOL, input: { text: 'read' } };
    case 'tool_arguments':
      return { name: SEND_TOOL, input: { text } };
    default:
      return { name: LOCAL_TOOL, input: {} };
  }
}


type SocketHandler<E> = ((event: E) => void) | null;

/** A scripted Gemini Live socket: it completes setup, and keeps what the session sent. */
class ProbeSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  onopen: SocketHandler<Event> = null;
  onmessage: SocketHandler<MessageEvent> = null;
  onerror: SocketHandler<Event> = null;
  onclose: SocketHandler<CloseEvent> = null;

  send(data: string): void {
    this.sent.push(data);
    if (data.includes('"setup"')) queueMicrotask(() => this.deliver({ setupComplete: true }));
  }

  close(): void {
    this.readyState = 3;
    const event = new CloseEvent('close', { code: 1000 });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }

  open(): void {
    this.readyState = 1;
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent(event);
  }

  deliver(payload: unknown): void {
    const event = new MessageEvent('message', { data: JSON.stringify(payload) });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  /** The frames the session sent, parsed. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

const LIVE_SESSION_BOUNDARIES: ReadonlySet<ProbeBoundary> = new Set([
  'user',
  'history',
  'system',
  'reply',
]);

/** A session that stays quiet this long after its last event is done. */
const LIVE_IDLE_MS = 1500;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** The strings under `text` in a list of wire parts. */
function partTexts(parts: unknown): string[] {
  const found: string[] = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const text = record(part)?.text;
    if (typeof text === 'string') found.push(text);
  }
  return found;
}

/** The user turns of a `clientContent` frame, as their parts' text. */
function userTurnTexts(turns: unknown): string[] {
  return (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    const row = record(turn);
    return row?.role === 'user' ? partTexts(row.parts) : [];
  });
}

/** The text of a frame the session sent, by the part of the wire it rides in. */
function frameTexts(frame: Record<string, unknown>, boundary: ProbeBoundary): string[] {
  if (boundary === 'system') return partTexts(record(record(frame.setup)?.systemInstruction)?.parts);
  if (boundary === 'history') return userTurnTexts(record(frame.clientContent)?.turns);
  const text = record(frame.realtimeInput)?.text;
  return typeof text === 'string' ? [text] : [];
}

/** What the session sent at `boundary`: the last text for the user, every text otherwise. */
function sentText(socket: ProbeSocket, boundary: ProbeBoundary): string | undefined {
  const texts = socket.frames().flatMap((frame) => frameTexts(frame, boundary));
  return boundary === 'user' ? texts.at(-1) : texts.join('\n') || undefined;
}

/** Runs one probe in a Live session on a scripted socket, and returns what the session yielded. */
async function runLiveSession(
  scope: Awaited<ReturnType<typeof writtenScope>>['scope'],
  profile: Profile,
  probe: GuardrailProbe,
  sink: { write(record: TraceRecord): Promise<void> },
  events: TurnEvent[],
  signal?: AbortSignal,
): Promise<ProbeSocket> {
  const { boundary, text } = probe;
  const socket = new ProbeSocket();
  if (boundary === 'history' || boundary === 'system') {
    // why: A session that refuses what it is seeded with throws before it reports anything, so a
    // blocked probe reads the request first to show what was found. Otherwise the session reports it.
    const seeded = sanitizeTurnRequestWithEvents(
      {
        profile: profile.id,
        ...(boundary === 'system' ? { system: text } : {}),
        input: boundary === 'history' ? { history: [{ role: 'user', content: text }] } : {},
      },
      profile,
    );
    if (seeded.refusal) {
      events.push(...seeded.events);
      throw seeded.refusal;
    }
  }
  const session = await scope.runSession(
    {
      profile: profile.id,
      ...(boundary === 'system' ? { system: text } : {}),
      ...(boundary === 'history'
        ? {
          history: [
            { role: 'user', content: text },
            { role: 'assistant', content: 'ok' },
          ],
        }
        : {}),
      ...(signal ? { signal } : {}),
    },
    {
      // why: The socket is scripted, so no key is read for real; any slot the draft names has one.
      vault: new Proxy({}, { get: () => 'probe' }),
      openWebSocket: () => {
        queueMicrotask(() => {
          socket.open();
        });
        return Promise.resolve(socket as unknown as WebSocket);
      },
    },
    sink,
  );
  let last = Date.now();
  let finished = false;
  const drain = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      last = Date.now();
      if (event.type === 'error') finished = true;
      if (event.type === 'done' && event.stop?.kind !== 'generation_complete') finished = true;
    }
  })();
  try {
    await session.sendText(boundary === 'user' ? text : 'Run the probe.');
    {
      if (boundary === 'reply') {
        socket.deliver({
          serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } },
        });
        for (const chunk of chunks(text)) {
          socket.deliver({ serverContent: { outputTranscription: { text: chunk } } });
        }
      }
      socket.deliver({ serverContent: { generationComplete: true } });
      socket.deliver({ serverContent: { turnComplete: true } });
    }
    while (!finished && Date.now() - last < LIVE_IDLE_MS && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    socket.close();
    await session.close();
    await drain.catch(() => undefined);
  }
  return socket;
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

/** The probe's text past its boundary in a Live session: what went out on the socket, or what the user got. */
function passedLive(
  boundary: ProbeBoundary,
  events: readonly TurnEvent[],
  socket: ProbeSocket,
): string | undefined {
  switch (boundary) {
    case 'user':
    case 'history':
    case 'system':
      return sentText(socket, boundary);
    case 'reply': {
      // why: Speech is heard, so what the user got is the transcript the gate released.
      const spoken = events
        .flatMap((event) =>
          event.type === 'evidence' && event.evidence.kind === 'output_transcription'
            ? [event.text ?? '']
            : [],
        )
        .join('');
      return said(events, 'text') ?? (spoken === '' ? undefined : spoken);
    }
    default:
      return undefined;
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

/** The agent types the tester runs, with the boundaries each one's turn crosses. */
const TYPE_BOUNDARIES: Partial<Record<ProfileDefinition['type'], readonly ProbeBoundary[]>> = {
  text: PROBE_BOUNDARIES,
  image: PROBE_BOUNDARIES,
  // A speech agent reads what it is asked to say, as the transcript. It takes no system prompt,
  // calls no tool and writes no reply.
  speech: ['user', 'history'],
  // A host runs tools and no model: only what crosses a tool is read.
  host: ['tool_result_local', 'tool_result_remote', 'tool_arguments'],
  // A Live session reads what is typed into it, what it is seeded with, what its tools take and
  // return, and what it says. A remote tool's reply and a thought are not probed.
  live: ['user', 'history', 'system', 'tool_result_local', 'tool_arguments', 'reply'],
};

/** The boundaries a turn of `profile` crosses, in the order of {@linkcode PROBE_BOUNDARIES}. */
function probeBoundariesOf(profile: ProfileDefinition): readonly ProbeBoundary[] {
  return TYPE_BOUNDARIES[profile.type] ?? [];
}

/** Why `profile` can't be probed, or undefined when it can. */
export function probeRefusal(profile: ProfileDefinition): string | undefined {
  if (TYPE_BOUNDARIES[profile.type]) return undefined;
  return profile.type === 'decision'
    ? 'A decision agent runs no text guardrails; what leaves its state is gated by guardrails.disclosure.'
    : `Guardrail tests don’t run on ${profile.type} agents yet.`;
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

/** Throws when `profile` cannot be sent `probe`: it is refused, has no such boundary, or the text is too long. */
function assertProbeable(
  profile: ProfileDefinition,
  probe: GuardrailProbe,
): asserts profile is Exclude<ProfileDefinition, { type: 'decision' }> {
  const refusal = probeRefusal(profile);
  if (refusal || profile.type === 'decision') {
    throw new TheoremError('request', refusal ?? ''); // lexicon-exempt: builder diagnostic
  }
  if (!probeBoundariesOf(profile).includes(probe.boundary)) {
    // lexicon-exempt: builder diagnostic
    throw new TheoremError(
      'request',
      `A ${profile.type} agent has no ${PROBE_BOUNDARY_NOTES[probe.boundary].label} boundary.`,
    );
  }
  if (probe.text.length > PROBE_TEXT_LIMIT) {
    throw new TheoremError('request', `A probe is at most ${PROBE_TEXT_LIMIT} characters.`); // lexicon-exempt: builder diagnostic
  }
}

/** Where a probe runs: a host or a live agent calls the tool, any other takes a turn. */
function probeStream(run: {
  scope: Awaited<ReturnType<typeof writtenScope>>['scope'];
  profile: Profile;
  type: ProfileDefinition['type'];
  probe: GuardrailProbe;
  signal?: AbortSignal;
  onAgentCall: ReturnType<typeof agentCallHook>;
  provider: (asked: Profile) => ModelProvider;
  sink: { write(record: TraceRecord): Promise<void> };
}): AsyncGenerator<TurnEvent> {
  const { scope, profile, probe, signal, onAgentCall, sink } = run;
  if (run.type === 'host' || run.type === 'live') {
    return scope.invokeTool({ profile: profile.id, ...hostCall(probe), signal, onAgentCall }, sink);
  }
  return scope.runTurn(
    {
      profile: profile.id,
      input: turnInput(probe),
      ...(probe.boundary === 'system' ? { system: probe.text } : {}),
      signal,
      onAgentCall,
    },
    runtimeProvider({ mode: 'byok', provider: run.provider }, scope, profile),
    sink,
  );
}

/** What stopped the turn, when its guardrails did; throws for any other failure. */
function refusalOf(events: readonly TurnEvent[]): GuardrailProbeResult['refused'] {
  const failure = events.find((event) => event.type === 'error');
  if (failure?.type !== 'error') return undefined;
  if (!refusedBy(failure.errorKind, events)) {
    throw new TheoremError(failure.errorKind, failure.errorInternal ?? failure.error ?? ''); // lexicon-exempt: builder diagnostic
  }
  return { kind: failure.errorKind, message: failure.error };
}

/** Whether the turn read a remote result as steering, or only as tainted. */
function taintOf(guardrails: readonly GuardrailEvent[]): 'steered' | 'tainted' | undefined {
  const rules = new Set(guardrails.flatMap((event) => event.hits.map((hit) => hit.rule)));
  if (rules.has(TOOL_RULES.steeredTurn)) return 'steered';
  return rules.has(TOOL_RULES.taintedTurn) ? 'tainted' : undefined;
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
  const asked = args.profile;
  assertProbeable(asked, probe);
  const { scope, profile } = await writtenScope([
    ...(args.dependencies ?? []),
    ...(asked.type === 'speech' || asked.type === 'live' ? [] : [remoteAgent(asked)]),
    probedDraft(asked, args.customTools, args.structured, probe.text),
  ]);
  if (!profile) throw new TheoremError('request', 'No agent to probe.'); // lexicon-exempt: builder diagnostic

  const seen: ProviderCompleteRequest[] = [];
  const model = scripted(script(probe), seen);
  const remote = scripted([[{ type: 'text', text: probe.text }]], []);
  const provider = (asked: Profile): ModelProvider => (asked.id === REMOTE_AGENT ? remote : model);

  const events: TurnEvent[] = [];
  const traces: TraceRecord[] = [];
  const sink = {
    write: (record: TraceRecord) => {
      traces.push(record);
      return Promise.resolve();
    },
  };
  const onAgentCall = agentCallHook(scope, { mode: 'byok', provider });
  let refused: GuardrailProbeResult['refused'];
  let socket: ProbeSocket | undefined;
  // why: A Live session reads what goes in and what it says; a tool it calls is run by the host
  // through `invokeTool`, which is where the arguments and the result are read.
  const viaSession = asked.type === 'live' && LIVE_SESSION_BOUNDARIES.has(probe.boundary);
  try {
    if (viaSession) {
      socket = await runLiveSession(scope, profile, probe, sink, events, args.signal);
    }
    for await (const event of viaSession
      ? []
      : probeStream({ scope, profile, type: asked.type, probe, signal: args.signal, onAgentCall, provider, sink })) {
      events.push(event);
    }
  } catch (error) {
    if (!(error instanceof TheoremError && refusedBy(error.kind, events))) throw error;
    refused = { kind: error.kind, message: error.message };
  }
  refused ??= refusalOf(events);

  const guardrails = events.flatMap((event) =>
    event.type === 'guardrail' ? [event.guardrail] : [],
  );
  const text = socket ? passedLive(probe.boundary, events, socket) : passed(probe.boundary, events, seen);
  const taint = taintOf(guardrails);
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

/**
 * Runs `text` across every boundary of the draft, each in its own turn, in the order of
 * {@linkcode PROBE_BOUNDARIES}. Given `only`, a detector's key, the draft reads with that
 * detector alone, and the answers are the boundaries where it is not set to ignore.
 */
export function runGuardrailProbes(
  args: Omit<Parameters<typeof runGuardrailProbe>[0], 'probe'> & { text: string; only?: string },
): Promise<GuardrailProbeAnswer[]> {
  const { text, only, ...draft } = args;
  const profile = only === undefined ? draft.profile : onlyDetector(draft.profile, only);
  const boundaries = only === undefined ? probeBoundariesOf(profile) : readBy(profile, only);
  return Promise.all(
    boundaries.map(async (boundary) => ({
      boundary,
      ...(await runGuardrailProbe({ ...draft, profile, probe: { boundary, text } })),
    })),
  );
}
