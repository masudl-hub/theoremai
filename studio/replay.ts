/**
 * A recorded conversation, run again through the profile as it is now. Every model call is
 * answered from the recording, in order, and by default every tool's result too; the profile's
 * guardrails, stages, gates and transcript run for real. When the profile asks for something the
 * recording does not hold, the replay stops there and says why (a divergence).
 *
 * The recording is a run's `TraceRecord`s: one per turn, with its model calls (`chat` spans) and
 * tool calls (`execute_tool` spans). A replay needs no keys: it reaches no model.
 *
 * @module
 */
import { type Profile, TheoremError, traceRecordSchema } from '@theoremjs/agents';
import { foldConversationTurn, type TranscriptBlock } from '@theoremjs/agents/interface';
import type {
  ModelEvent,
  ModelRequest,
  Source,
  TurnEvent,
  TurnModel,
} from '@theoremjs/agents/kernel';
import {
  inlineContent,
  recordRoot,
  TRACE_VERSION,
  type TraceAttributeValue,
  type TraceRecord,
  type TraceSpan,
} from '@theoremjs/agents/observability';
import type { ToolRegistration } from './registrations.ts';
import type { StudioRunPayload } from './run-payload.ts';
import type { StudioToolHandlers } from './tools.ts';

/** One model call as recorded: what it answered, and whether the recording holds all of it. */
export interface ReplayCall {
  /** The agent that made the call. */
  agent: string;
  events: ModelEvent[];
  /** The tools its reply calls, by name. */
  calls: string[];
  /** Some of the reply was not recorded (media a model made), so it cannot be answered again. */
  missing: boolean;
}

/** One tool call's recorded result. */
export interface ReplayResult {
  name: string;
  result: string;
  failed: boolean;
}

/** One recorded turn: what the person sent, the model calls and tool results it took, and what they saw. */
export interface ReplayTurn {
  text: string;
  /** Files sent with the message. Their bytes are never recorded, so such a turn cannot be sent again. */
  attachments: number;
  calls: ReplayCall[];
  results: ReplayResult[];
  /** The turn as the person saw it. */
  blocks: TranscriptBlock[];
}

/** One conversation of a recording, as a replay reads it. */
export interface ReplayScript {
  /** The agent the conversation was with. */
  agent: string;
  /** Its `gen_ai.conversation.id`; absent when its turns carried none. */
  conversation?: string;
  turns: ReplayTurn[];
  /** The records its turns came from, in the file's order. */
  records: TraceRecord[];
  /** When the first turn started (epoch ms). */
  recordedAt?: number;
}

/** Why a replay stopped where it did. */
export type ReplayDivergence = {
  /** The turn, from 0. */
  turn: number;
  reason: string;
} & (
  | {
      /** The agent whose model call diverged. */
      agent: string;
      /** That agent's model call within the turn, from 1. */
      call: number;
    }
  | {
      /** The tool the recording holds no further result for. */
      tool: string;
    }
);

type Part = Record<string, unknown>;
type Message = { role?: unknown; parts?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const attribute = (span: TraceSpan, name: string): TraceAttributeValue | undefined =>
  span.attributes[name];

const stringAttribute = (span: TraceSpan, name: string): string | undefined => {
  const value = attribute(span, name);
  return typeof value === 'string' ? value : undefined;
};

/** A stored attribute, its content put back. */
function content(record: TraceRecord, span: TraceSpan, name: string): unknown {
  const value = attribute(span, name);
  return value === undefined ? undefined : inlineContent(record, value);
}

/** A stored attribute as text: its content, or its JSON. */
function contentText(record: TraceRecord, span: TraceSpan, name: string): string {
  const value = content(record, span, name);
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function messagesOf(record: TraceRecord, span: TraceSpan, name: string): Message[] {
  const value = content(record, span, name);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const partsOf = (message: Message): Part[] =>
  Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];

const startOf = (span: TraceSpan): bigint => BigInt(String(span.startTimeUnixNano));

const byStart = (a: TraceSpan, b: TraceSpan): number => {
  const order = startOf(a) - startOf(b);
  return order === 0n ? 0 : order < 0n ? -1 : 1;
};

/**
 * Wall-clock start/end (epoch ms) of a finished span. Live tool phases and
 * `stampWorked` use the same clocks; recordings read them from the span.
 */
function boundsOf(span: TraceSpan): { startedAt: number; endedAt: number } | undefined {
  const endRaw = span.endTimeUnixNano;
  if (!endRaw) return undefined;
  const start = startOf(span);
  const end = BigInt(String(endRaw));
  if (end <= start) return undefined;
  const startedAt = Number(start / 1_000_000n);
  const endedAt = Number(end / 1_000_000n);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    return undefined;
  }
  return { startedAt, endedAt };
}

/**
 * How long the turn worked on the wall clock, from the root span's start/end.
 * Live chats stamp this on `turn-done` via `stampWorked`; recordings must too
 * or the opener only says "Worked".
 */
function workedOf(root: TraceSpan): { workedMs: number; endedAt: number } | undefined {
  const bounds = boundsOf(root);
  if (!bounds) return undefined;
  return { workedMs: bounds.endedAt - bounds.startedAt, endedAt: bounds.endedAt };
}

/** `blocks` with its last `turn-done` carrying the root span's work (same as live `stampWorked`). */
function stampOpeningWork(blocks: TranscriptBlock[], root: TraceSpan): TranscriptBlock[] {
  const worked = workedOf(root);
  if (!worked) return blocks;
  const last = blocks.findLastIndex((block) => block.kind === 'turn-done');
  if (last < 0) return blocks;
  return blocks.map((block, index) => (index === last ? { ...block, ...worked } : block));
}

/** A part whose content the record does not hold keeps its hash. */
const unrecorded = (part: Part): boolean => 'content_sha256' in part || 'json_sha256' in part;

/** A tool call's arguments, as the model sent them. */
function argumentsOf(part: Part): Record<string, unknown> {
  const raw = part.arguments;
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The text or visible thought a recorded part says, if it says any. */
function saidOf(part: Part): { type: 'thought' | 'text'; text: string } | undefined {
  if (typeof part.content !== 'string') return undefined;
  if (part.type === 'reasoning') return { type: 'thought', text: part.content };
  if (part.type === 'text') return { type: 'text', text: part.content };
  return undefined;
}

/** The events one recorded reply stands for, in the order the model wrote them. */
function replyEvents(messages: readonly Message[]): Omit<ReplayCall, 'agent'> {
  const events: ModelEvent[] = [];
  const calls: string[] = [];
  let missing = false;
  for (const message of messages) {
    const parts = partsOf(message);
    const hasText = parts.some((part) => part.type === 'text');
    for (const part of parts) {
      const said = saidOf(part);
      if (unrecorded(part)) missing = true;
      else if (said) events.push(said);
      else if (part.type === 'structured' && !hasText)
        events.push({ type: 'text', text: JSON.stringify(part.content) });
      else if (part.type === 'tool_call' && typeof part.name === 'string') {
        calls.push(part.name);
        events.push({
          type: 'tool',
          tool: {
            name: part.name,
            callId: typeof part.id === 'string' ? part.id : `replay-${String(calls.length)}`,
            arguments: argumentsOf(part),
          },
        });
      } else if (part.type === 'blob' || part.type === 'uri') missing = true;
    }
  }
  return { events, calls, missing };
}

/** The agent whose turn `span` is part of: the nearest `invoke_agent` above it. */
function agentOf(span: TraceSpan, spans: ReadonlyMap<string, TraceSpan>): string {
  for (let at: TraceSpan | undefined = span; at; at = spans.get(at.parentSpanId ?? '')) {
    const name = stringAttribute(at, 'gen_ai.agent.name');
    if (stringAttribute(at, 'gen_ai.operation.name') === 'invoke_agent' && name) return name;
  }
  return '';
}

const operation = (span: TraceSpan) => stringAttribute(span, 'gen_ai.operation.name');

/** The model calls a record holds, in order, each with its agent and ending as it was recorded to. */
function recordCalls(record: TraceRecord): ReplayCall[] {
  const spans = new Map(record.spans.map((span) => [span.spanId, span]));
  return record.spans
    .filter((span) => operation(span) === 'chat')
    .toSorted(byStart)
    .map((span) => {
      const reply = replyEvents(messagesOf(record, span, 'gen_ai.output.messages'));
      const kind = stringAttribute(span, 'theorem.stop.kind') ?? 'completed';
      return {
        agent: agentOf(span, spans),
        ...reply,
        events: [...reply.events, { type: 'done', stop: { kind } } as ModelEvent],
      };
    });
}

/** The tool results a record holds, in order. */
function recordResults(record: TraceRecord): ReplayResult[] {
  return record.spans
    .filter((span) => operation(span) === 'execute_tool')
    .toSorted(byStart)
    .map((span) => ({
      name: stringAttribute(span, 'gen_ai.tool.name') ?? '',
      result: contentText(record, span, 'gen_ai.tool.call.result'),
      failed: stringAttribute(span, 'theorem.tool.outcome') === 'error',
    }));
}

/** What the person sent: the turn's last user message. */
function userMessage(record: TraceRecord, root: TraceSpan): { text: string; attachments: number } {
  const user = messagesOf(record, root, 'gen_ai.input.messages').findLast(
    (message) => message.role === 'user',
  );
  const parts = user ? partsOf(user) : [];
  return {
    text: parts
      .flatMap((part) =>
        part.type === 'text' && typeof part.content === 'string' ? [part.content] : [],
      )
      .join('\n'),
    attachments: parts.filter((part) => part.type === 'blob' || part.type === 'uri').length,
  };
}

/** Sources a tool span recorded on `theorem.grounding`, when the record still holds them. */
function groundingSources(record: TraceRecord, span: TraceSpan): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const event of span.events ?? []) {
    if (event.name !== 'theorem.grounding') continue;
    const raw = event.attributes.sources;
    if (raw === undefined) continue;
    const sources = inlineContent(record, raw);
    if (!Array.isArray(sources)) continue;
    const held: Source[] = [];
    for (const source of sources) {
      if (!isRecord(source)) continue;
      if (typeof source.title !== 'string' || typeof source.uri !== 'string') continue;
      held.push({
        title: source.title,
        uri: source.uri,
        type: source.type === 'maps' ? 'maps' : 'web',
        ...(typeof source.placeId === 'string' ? { placeId: source.placeId } : {}),
      });
    }
    if (held.length) {
      const callId = stringAttribute(span, 'gen_ai.tool.call.id');
      events.push({ type: 'citation', sources: held, ...(callId ? { callId } : {}) });
    }
  }
  return events;
}

/** The events the person was shown in a turn, from what it delivered and the tools it ran. */
function shownEvents(record: TraceRecord, root: TraceSpan): TurnEvent[] {
  const tools = record.spans.filter((span) => operation(span) === 'execute_tool').toSorted(byStart);
  const used = new Set<TraceSpan>();
  /** The tool span for a call: by its id, else the next one by its name. */
  const toolSpan = (callId: string, name: string) => {
    const span =
      tools.find((each) => stringAttribute(each, 'gen_ai.tool.call.id') === callId) ??
      tools.find((each) => !used.has(each) && stringAttribute(each, 'gen_ai.tool.name') === name);
    if (span) used.add(span);
    return span;
  };
  const events: TurnEvent[] = [];
  for (const message of messagesOf(record, root, 'gen_ai.output.messages')) {
    for (const part of partsOf(message)) {
      const said = saidOf(part);
      if (said) events.push(said);
      else if (part.type === 'structured' && part.content !== undefined)
        events.push({ type: 'structured', structured: part.content });
      else if (part.type === 'tool_call' && typeof part.name === 'string') {
        const callId = typeof part.id === 'string' ? part.id : `call-${String(events.length)}`;
        events.push(...toolEvents(record, part.name, callId, argumentsOf(part), toolSpan));
      }
    }
  }
  const failure = contentText(record, root, 'theorem.error.public');
  if (root.status.code === 'ERROR')
    events.push({ type: 'error', errorKind: 'internal', error: failure || root.status.message });
  const kind = stringAttribute(root, 'theorem.stop.kind') ?? 'completed';
  events.push({ type: 'done', stop: { kind } } as TurnEvent);
  return events;
}

/** A tool call and how it ended, as the transcript shows it. */
function toolEvents(
  record: TraceRecord,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  toolSpan: (callId: string, name: string) => TraceSpan | undefined,
): TurnEvent[] {
  const span = toolSpan(callId, name);
  const made: TurnEvent = { type: 'tool', tool: { name, callId, arguments: args } };
  if (!span) return [made];
  // why: Live emits running then settle with `at` clocks; the fold only sets
  // startedAt on running. Recordings hold the same clocks on the execute_tool
  // span — emit both phases or the chat hides tool duration.
  const bounds = boundsOf(span);
  const startedAt = bounds?.startedAt ?? Number(startOf(span) / 1_000_000n);
  const endedAt = bounds?.endedAt ?? startedAt;
  const result = contentText(record, span, 'gen_ai.tool.call.result');
  const failed = stringAttribute(span, 'theorem.tool.outcome') === 'error';
  // why: historyFromTranscriptBlocks replays settled calls via `readBack`; a live turn sets it on
  // every complete/error event, so a recording must too or startConversation refuses the exchange.
  const settled = failed
    ? {
        phase: 'error' as const,
        failure: {
          code: stringAttribute(span, 'theorem.tool.failure.code') ?? 'failed',
          kind: 'internal' as const,
          message: result,
        },
        readBack: result,
      }
    : { phase: 'complete' as const, output: shownOutput(record, span, result), readBack: result };
  return [
    made,
    { type: 'tool', tool: { name, callId, phase: 'running', at: startedAt } },
    { type: 'tool', tool: { name, callId, at: endedAt, ...settled } },
    ...groundingSources(record, span),
  ];
}

/**
 * What the person was shown: the tool's raw output where the span recorded it.
 * why: `gen_ai.tool.call.result` is what the model read back, fenced in `<tool_data>` for a remote tool.
 */
function shownOutput(record: TraceRecord, span: TraceSpan, result: string): unknown {
  return 'theorem.tool.data' in span.attributes
    ? content(record, span, 'theorem.tool.data')
    : parsed(result);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const spanKey = (traceId: string, spanId: string) => `${traceId}:${spanId}`;

/** A record the kernel wrote for a compaction between turns: no input, a `theorem.compaction` event. */
function compactionOnly(record: TraceRecord, root: TraceSpan): boolean {
  if (!root.events.some((event) => event.name === 'theorem.compaction')) return false;
  const sent = userMessage(record, root);
  return !sent.text && sent.attachments === 0;
}

/**
 * The conversations a run's records stand for, in the order each began. Each record whose root
 * is an agent's turn is a turn of the conversation its `gen_ai.conversation.id` names; one agent's
 * turns with no id are one conversation. A record whose root's parent span is in a turn's record
 * (a turn a host ran under `traceparent`) adds its calls to that turn; an agent tool's turn is
 * already inside its caller's record. Compactions between turns and records of anything else (a
 * host's tool call, a decision) hold no turn.
 */
export function replayScripts(records: readonly TraceRecord[]): ReplayScript[] {
  const scripts = new Map<string, ReplayScript>();
  /** The turn each recorded span belongs to, by `traceId:spanId`, and its conversation. */
  const owners = new Map<string, { turn: ReplayTurn; script: ReplayScript }>();
  const claim = (record: TraceRecord, owner: { turn: ReplayTurn; script: ReplayScript }) => {
    for (const span of record.spans) owners.set(spanKey(span.traceId, span.spanId), owner);
    owner.script.records.push(record);
  };
  records.forEach((record, index) => {
    const root = recordRoot(record);
    if (!root || operation(root) !== 'invoke_agent' || compactionOnly(record, root)) return;
    const calls = recordCalls(record);
    const results = recordResults(record);
    const parent = root.parentSpanId
      ? owners.get(spanKey(root.traceId, root.parentSpanId))
      : undefined;
    if (parent) {
      parent.turn.calls.push(...calls);
      parent.turn.results.push(...results);
      claim(record, parent);
      return;
    }
    const agent = stringAttribute(root, 'gen_ai.agent.name') ?? '';
    const conversation = stringAttribute(root, 'gen_ai.conversation.id');
    const key = `${agent}\u0000${conversation ?? ''}`;
    let script = scripts.get(key);
    if (!script) {
      script = {
        agent,
        ...(conversation === undefined ? {} : { conversation }),
        turns: [],
        records: [],
        recordedAt: Number(startOf(root) / 1_000_000n),
      };
      scripts.set(key, script);
    }
    const sent = userMessage(record, root);
    const turn: ReplayTurn = {
      ...sent,
      calls,
      results,
      blocks: stampOpeningWork(
        foldConversationTurn({ text: sent.text }, shownEvents(record, root), {
          idPrefix: `recorded-${String(index)}`,
        }),
        root,
      ),
    };
    script.turns.push(turn);
    claim(record, { turn, script });
  });
  return [...scripts.values()];
}

/** A recorded result as a function tool returns it: its JSON object, else its text. */
function resultOutput(result: ReplayResult): Record<string, unknown> {
  if (result.failed) throw new Error(result.result);
  const value = parsed(result.result);
  return isRecord(value) ? value : { result: value };
}

/** Ordinal wording for a call's place in its turn. */
const nth = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${String(n)}${suffix}`;
};

/** The divergence, if `call` cannot answer `request`. */
function divergence(
  call: ReplayCall | undefined,
  recorded: number,
  request: ModelRequest,
): string | undefined {
  if (!call)
    return `The profile asked the model a ${nth(recorded + 1)} time this turn; the recording answered ${String(recorded)}.`;
  if (call.missing) return 'The recording does not hold all of this reply.';
  const offered = new Set((request.wireTools ?? []).map((tool) => tool.name));
  const gone = call.calls.find((name) => !offered.has(name));
  return gone && `The recording calls ${gone}, which the profile no longer offers.`;
}

export interface Replay {
  /** Answers each model call from the recording: pass as the runtime's `provider`. */
  provider: (profile: Profile) => TurnModel;
  /** Answers each tool from the recording, by name, in order: pass as the runtime's `toolHandlers`. */
  toolHandlers: StudioToolHandlers;
  /**
   * Sets the turn the next calls belong to. A turn set again goes on where it stopped: a reply
   * that waited on a gate resumes with the calls it had left.
   */
  startTurn(turn: number): void;
}

/**
 * A replay of `script` for the agent `agent` (the conversation's agent, as the profile now names
 * it). `onDiverge` hears where it stopped; the call that diverged then fails its turn.
 */
export function createReplay(
  script: ReplayScript,
  agent: string,
  onDiverge: (divergence: ReplayDivergence) => void,
): Replay {
  let turn = 0;
  /** How often each agent has asked in each turn, by `turn agent`. */
  const asked = new Map<string, number>();
  /** Each turn's results not yet given, by tool name. */
  const pending = new Map<number, Map<string, ReplayResult[]>>();
  const resultsOf = (index: number) => {
    let results = pending.get(index);
    if (!results) {
      results = new Map();
      for (const result of script.turns[index]?.results ?? [])
        results.set(result.name, [...(results.get(result.name) ?? []), result]);
      pending.set(index, results);
    }
    return results;
  };
  const model = (name: string): TurnModel => ({
    // why: a generator, so a divergence fails the call the engine is reading, not the one before.
    async *complete(request) {
      const calls = script.turns[turn]?.calls.filter((call) => call.agent === name) ?? [];
      const key = `${String(turn)} ${name}`;
      const index = asked.get(key) ?? 0;
      asked.set(key, index + 1);
      const reason = divergence(calls[index], calls.length, request);
      if (reason) {
        onDiverge({ turn, agent: name, call: index + 1, reason });
        throw new TheoremError('request', `Replay stopped: ${reason}`); // labels-exempt: builder diagnostic
      }
      yield* calls[index]?.events ?? [];
    },
  });
  const handler = (name: string) => () => {
    const next = resultsOf(turn).get(name)?.shift();
    if (!next) {
      const reason = `The recording has no further result for ${name}.`;
      onDiverge({ turn, tool: name, reason });
      throw new TheoremError('request', `Replay stopped: ${reason}`); // labels-exempt: builder diagnostic
    }
    return resultOutput(next);
  };
  const names = new Set(script.turns.flatMap((each) => each.results.map((result) => result.name)));
  const toolHandlers = Object.fromEntries([...names].map((name) => [name, handler(name)]));
  return {
    provider: (profile) => model(profile.id === agent ? script.agent : profile.id),
    toolHandlers,
    startTurn: (index) => {
      turn = index;
    },
  };
}

/**
 * `tools` with every tool that reaches past the page answered by a handler instead: http, MCP,
 * the page's own, and those that answer with a sample. An agent tool still runs its agent, whose
 * model calls the replay answers too.
 */
export function recordedTools(tools: readonly ToolRegistration[]): ToolRegistration[] {
  return tools.map((tool) => {
    if (tool.type === 'agent') return tool;
    const { name, description, category, access, permission, loadTier, paths } = tool;
    return {
      type: 'function',
      name,
      description,
      category,
      access,
      permission,
      loadTier,
      paths,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      ...(tool.labels ? { labels: tool.labels } : {}),
    };
  });
}

/** `payload` with its tools, and those of the agents it names, answered from the recording. */
export function recordedPayload(payload: StudioRunPayload): StudioRunPayload {
  return {
    ...payload,
    customTools: recordedTools(payload.customTools),
    ...(payload.dependencies
      ? {
          dependencies: payload.dependencies.map((dependency) => ({
            ...dependency,
            customTools: recordedTools(dependency.customTools),
          })),
        }
      : {}),
  };
}

/** The conversation as the person saw it, every turn. */
export function recordedTranscript(script: ReplayScript): TranscriptBlock[] {
  return script.turns.flatMap((turn) => turn.blocks);
}

/**
 * The recording's first conversation, opened as history: the same blocks Replay exchange shows and
 * Continue live seeds. Goals and any host that starts on a recorded trace use this, not a second
 * hand-written exchange. Each assistant `turn-done` carries `workedMs` / `endedAt` from its root
 * span, as a live chat's `stampWorked` would. Each settled tool carries `startedAt` / `endedAt`
 * from its `execute_tool` span (via running then settle), as a live turn would.
 */
export function openingFromRecords(records: readonly TraceRecord[]): TranscriptBlock[] {
  const [first] = replayScripts(records);
  return first ? recordedTranscript(first) : [];
}

/** One record of a trace file, or why it is not one; `where` names its place in the file. */
function traceRecordAt(value: unknown, where: string): TraceRecord {
  const parsed = traceRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const version = isRecord(value) ? value.v : undefined;
  // labels-exempt: builder diagnostic
  const why =
    typeof version === 'number' && version !== TRACE_VERSION
      ? `This trace is version ${String(version)}${where}; the studio reads version ${String(TRACE_VERSION)}.`
      : `This file is not a Theorem trace${where}.`;
  throw new TheoremError('request', why);
}

/**
 * The records a parsed trace value holds: a JSON array of `TraceRecord`s, as the studio
 * downloads them, or one record. Throws, saying why, for anything else.
 */
export function parseTraceRecords(value: unknown): TraceRecord[] {
  const records = Array.isArray(value) ? value : [value];
  return records.map((record, index) =>
    traceRecordAt(record, records.length > 1 ? ` (record ${String(index + 1)})` : ''),
  );
}

/**
 * The records a trace file holds: a JSON array of `TraceRecord`s, as the studio downloads them,
 * one record, or JSONL with a record on each line, as `jsonlSink` writes them. Throws, saying
 * why, for anything else; a JSONL file's problems name their line.
 */
export function parseTraceFile(text: string): TraceRecord[] {
  try {
    return parseTraceRecords(JSON.parse(text));
  } catch (error) {
    if (error instanceof TheoremError) throw error;
  }
  const lines = text.split('\n').map((line, index) => ({ line, at: index + 1 }));
  const filled = lines.filter(({ line }) => line.trim());
  if (filled.length < 2) throw new TheoremError('request', 'This file is not JSON.'); // labels-exempt: builder diagnostic
  return filled.map(({ line, at }) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // labels-exempt: builder diagnostic
      throw new TheoremError('request', `Line ${String(at)} of this file is not JSON.`);
    }
    return traceRecordAt(value, ` (line ${String(at)})`);
  });
}
