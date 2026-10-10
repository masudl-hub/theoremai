import {
  inlineContent,
  type TraceEventMeta,
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
} from '@theoremjs/agents';
import { isRecord } from '@theoremjs/agents/kernel';
import {
  nanosToMs,
  type TraceNode,
  type TraceTotals,
  traceSpans,
  traceTotals,
} from './trace-view.ts';

/**
 * The trace panel's story of a turn: who acted, in what order, and where the
 * time went, read from the span tree. The words still come from the trace
 * catalog; this only decides what a person reads first.
 *
 * @module
 */

/** Who acted in a step: sets its colour and icon. */
export type TraceActor = 'user' | 'model' | 'tool' | 'host' | 'theorem' | 'error';

/** One root of the tree (a turn, a Live session, a host span) with its totals and where its time went. */
export interface TraceTurn {
  node: TraceNode;
  totals: TraceTotals;
  split: TraceTimeSplit;
  /** The turn itself ended in an error (a step that failed and was recovered from does not count). */
  failed: boolean;
}

export function traceTurns(tree: readonly TraceNode[]): TraceTurn[] {
  return tree.map((node) => ({
    node,
    totals: traceTotals([node]),
    split: traceTimeSplit(node),
    failed: node.span.status.code === 'ERROR',
  }));
}

/** A host's trace: each root is one tool call, not a conversation's turn. */
export function isCallTrace(turns: readonly TraceTurn[]): boolean {
  return turns.length > 0 && turns.every((turn) => TOOL_TYPES.has(turn.node.meta.type));
}

/** A row of the whole-trace list: who it's by, what names it, and how it ended. */
export type TraceTurnRow = {
  actor: TraceActor;
  title?: string;
  outcome?: TraceOutcome;
  answered?: string;
};

/** A turn named by what the person asked, a host's call by its tool; a failure by its outcome, else the answer. */
export function traceTurnRow(turn: TraceTurn, isCall: boolean): TraceTurnRow {
  const story = traceStory(turn.node);
  const ask = story.find((step) => step.kind === 'ask');
  const answer = story.findLast((step) => step.kind === 'answer');
  const title = isCall ? turn.node.meta.subject : ask?.kind === 'ask' ? ask.text : undefined;
  const outcome = turn.failed ? traceOutcome(turn.node) : undefined;
  const answered = answer?.kind === 'answer' ? answer.text : undefined;
  return {
    actor: turn.failed ? 'error' : isCall ? 'tool' : 'user',
    ...(title ? { title } : {}),
    ...(outcome ? { outcome } : answered ? { answered } : {}),
  };
}

export function traceActor(node: TraceNode): TraceActor {
  if (node.span.status.code === 'ERROR') return 'error';
  switch (node.meta.type) {
    case 'call':
    case 'response':
    case 'decision':
      return 'model';
    case 'tool':
      return 'tool';
    case 'cutout':
    case 'host':
      return 'host';
    default:
      return 'theorem';
  }
}

/** One line of the story. `offsetMs` is from the turn's start. */
export type TraceStep =
  | { kind: 'ask'; id: string; node: TraceNode; offsetMs: number; text: string }
  | {
      kind: 'span';
      id: string;
      node: TraceNode;
      offsetMs: number;
      nested: boolean;
      requested: number;
    }
  | {
      kind: 'event';
      id: string;
      node: TraceNode;
      offsetMs: number;
      label: string;
      detail: readonly string[];
      doc: string;
    }
  | { kind: 'answer'; id: string; node: TraceNode; offsetMs: number; text?: string };

/** Events worth a line of their own: something acted, retried, waited or warned. */
const STORY_EVENTS: ReadonlySet<string> = new Set([
  'theorem.guardrail',
  'theorem.attempt.retry',
  'theorem.gate',
  'theorem.tool.warning',
  'theorem.tool.cancel',
]);

/** Event keys whose value reads as a detail of the line, in this order. */
const EVENT_DETAIL_KEYS = ['action', 'stage', 'kind', 'reason', 'code'] as const;

function stepOf(node: TraceNode): number | undefined {
  const step = node.span.attributes['theorem.step'];
  return typeof step === 'number' ? step : undefined;
}

type Part = { type?: unknown; content?: unknown };

function messagesOf(node: TraceNode, key: string): { role?: unknown; parts?: unknown }[] {
  const value = inlineContent(node.record, node.span.attributes[key]);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(
      (part): part is Part =>
        isRecord(part) && part.type === 'text' && typeof part.content === 'string',
    )
    .map((part) => part.content)
    .join('\n')
    .trim();
}

/** The last message's text from `role`, read from a span's input or output messages. */
export function messageText(
  node: TraceNode,
  key: 'gen_ai.input.messages' | 'gen_ai.output.messages',
  role: string,
): string {
  const found = messagesOf(node, key).filter((message) => message.role === role);
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const text = partsText(found[index]?.parts);
    if (text) return text;
  }
  return '';
}

/** A model call that wrote text back (rather than only asking for tools). */
function wroteText(node: TraceNode): boolean {
  return messageText(node, 'gen_ai.output.messages', 'assistant') !== '';
}

function eventDetail(name: string, attributes: Readonly<Record<string, unknown>>): string[] {
  return EVENT_DETAIL_KEYS.flatMap((key) => {
    const value = attributes[key];
    if (typeof value !== 'string') return [];
    const meta = traceEventAttributeMeta(name, key);
    return [meta?.options?.[value]?.label ?? value];
  });
}

function isQuiet(name: string, attributes: Readonly<Record<string, unknown>>): boolean {
  return name === 'theorem.guardrail' && attributes.action === 'allow';
}

function storyEvents(node: TraceNode, turnStart: number): TraceStep[] {
  return node.span.events.flatMap((event, index) => {
    if (!STORY_EVENTS.has(event.name) || isQuiet(event.name, event.attributes)) return [];
    const meta: TraceEventMeta | undefined = traceEventMeta(event.name);
    return [
      {
        kind: 'event' as const,
        id: `${node.id}:event:${index}`,
        node,
        offsetMs: nanosToMs(event.timeUnixNano) - turnStart,
        label: meta?.label ?? event.name,
        detail: eventDetail(event.name, event.attributes),
        doc: meta?.doc ?? event.name,
      },
    ];
  });
}

/**
 * A turn as it happened: what the user asked, each model call and the tool
 * calls it asked for (nested under it), the events that changed the course,
 * and how it ended. HTTP tries stay in the timeline; they are how a call
 * travelled, not a step of the story.
 */
export function traceStory(root: TraceNode): TraceStep[] {
  const start = root.startMs;
  const spans = traceSpans(root.children)
    .filter((node) => node.meta.type !== 'http')
    .sort((a, b) => a.startMs - b.startMs);
  const toolsByStep = new Map<number, number>();
  for (const node of spans) {
    const step = stepOf(node);
    if (node.meta.type === 'tool' && step !== undefined)
      toolsByStep.set(step, (toolsByStep.get(step) ?? 0) + 1);
  }
  const calledSteps = new Set<number>();
  const steps: TraceStep[] = [];
  const asked = messageText(root, 'gen_ai.input.messages', 'user');
  if (asked)
    steps.push({ kind: 'ask', id: `${root.id}:ask`, node: root, offsetMs: 0, text: asked });
  steps.push(...storyEvents(root, start).filter((step) => step.offsetMs <= 0));
  for (const node of spans) {
    const step = stepOf(node);
    const isCall = node.meta.type === 'call' || node.meta.type === 'response';
    if (isCall && step !== undefined) calledSteps.add(step);
    steps.push({
      kind: 'span',
      id: node.id,
      node,
      offsetMs: node.startMs - start,
      nested: node.meta.type === 'tool' && step !== undefined && calledSteps.has(step),
      requested:
        isCall && step !== undefined && !wroteText(node) ? (toolsByStep.get(step) ?? 0) : 0,
    });
    steps.push(...storyEvents(node, start));
  }
  const rootEvents = storyEvents(root, start).filter((step) => step.offsetMs > 0);
  const ordered = [...steps, ...rootEvents].sort(
    (a, b) => a.offsetMs - b.offsetMs || rank(a) - rank(b),
  );
  if (root.meta.type === 'turn') {
    const answer = messageText(root, 'gen_ai.output.messages', 'assistant');
    ordered.push({
      kind: 'answer',
      id: `${root.id}:answer`,
      node: root,
      offsetMs: root.durationMs,
      ...(answer && { text: answer }),
    });
  }
  return ordered;
}

/** Keeps the question first and a span ahead of the events it recorded at the same instant. */
function rank(step: TraceStep): number {
  return step.kind === 'ask' ? 0 : step.kind === 'span' ? 1 : 2;
}

/** A tool call's arguments as `[key, value]` pairs of plain values, for a one-line summary. */
export function toolArguments(node: TraceNode): [string, string][] {
  const stored = inlineContent(node.record, node.span.attributes['gen_ai.tool.call.arguments']);
  let value: unknown = stored;
  if (typeof stored === 'string') {
    try {
      value = JSON.parse(stored);
    } catch {
      return stored ? [['', stored]] : [];
    }
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      ? [[key, String(item)] as [string, string]]
      : [],
  );
}

/** A stored JSON or text value, parsed when it is JSON. */
export function storedValue(node: TraceNode, key: string): unknown {
  const value = inlineContent(node.record, node.span.attributes[key]);
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** How a span ended when it did not simply succeed: a tool denied, paused or failed, or any span's error. */
export interface TraceOutcome {
  label: string;
  doc?: string;
  /** The tool's own failure code, shown as is. */
  code?: string;
  tone: 'error' | 'warning';
}

function optionOf(key: string, value: unknown): { label: string; doc: string } | undefined {
  return typeof value === 'string' ? traceAttributeMeta(key)?.options?.[value] : undefined;
}

export function traceOutcome(node: TraceNode): TraceOutcome | undefined {
  const { attributes, status } = node.span;
  const outcome = attributes['theorem.tool.outcome'];
  const code = attributes['theorem.tool.failure.code'];
  const codePart = typeof code === 'string' ? { code } : {};
  const tool = outcome !== 'ok' ? optionOf('theorem.tool.outcome', outcome) : undefined;
  if (tool)
    return {
      ...tool,
      ...codePart,
      tone: status.code === 'ERROR' || outcome === 'error' ? 'error' : 'warning',
    };
  if (status.code !== 'ERROR') return undefined;
  const type = attributes['error.type'];
  const kind = optionOf('error.type', type);
  if (kind) return { ...kind, ...codePart, tone: 'error' };
  return {
    label: typeof type === 'string' ? type : (status.message ?? ''),
    ...codePart,
    tone: 'error',
  };
}

/** One rule a guardrail check matched, worded by the catalog. */
export interface TraceGuardrailHit {
  rule: string;
  /** What the rule caught, in words; the id itself for a rule the catalog does not know, such as a host's own. */
  ruleLabel: string;
  /** Why the rule exists and what it does. */
  ruleDoc?: string;
  severity: string;
  /** The severity's label, when the catalog knows it. */
  severityLabel: string;
  /** The matched text, kept only when the profile records match previews. */
  match?: string;
}

/** One guardrail check: what it checked, what it did and why, and how long it took when timed. */
export interface TraceGuardrailCheck {
  id: string;
  /** The span it happened on: the turn, or the tool whose call or result it checked. */
  node: TraceNode;
  offsetMs: number;
  stage: string;
  stageLabel: string;
  /** Which timed check ran, in words, when the check was timed. */
  checkLabel?: string;
  action: string;
  actionLabel: string;
  actionDoc?: string;
  durationMs?: number;
  hits: readonly TraceGuardrailHit[];
  /** The tool the checked text came from. */
  tool?: string;
  /** The guardrail's own reason, for the builder. */
  reason?: string;
}

function guardrailHits(value: unknown): TraceGuardrailHit[] {
  if (!Array.isArray(value)) return [];
  const fields = traceEventAttributeMeta('theorem.guardrail', 'hits')?.fields;
  return value.filter(isRecord).flatMap((hit) => {
    if (typeof hit.rule !== 'string') return [];
    const severity = typeof hit.severity === 'string' ? hit.severity : '';
    // why: A host names its own rules on the hit; Theorem's are named in the catalog.
    const rule = fields?.rule?.options?.[hit.rule];
    const ruleDoc = typeof hit.doc === 'string' ? hit.doc : rule?.doc;
    return [
      {
        rule: hit.rule,
        ruleLabel: typeof hit.label === 'string' ? hit.label : (rule?.label ?? hit.rule),
        ...(ruleDoc && { ruleDoc }),
        severity,
        severityLabel: fields?.severity?.options?.[severity]?.label ?? severity,
        ...(typeof hit.match === 'string' && { match: hit.match }),
      },
    ];
  });
}

function eventOption(key: string, value: string): { label: string; doc: string } | undefined {
  return traceEventAttributeMeta('theorem.guardrail', key)?.options?.[value];
}

/** Every guardrail check the turn recorded, in the order they ran: the passes as well as what they caught. */
export function traceGuardrails(root: TraceNode): TraceGuardrailCheck[] {
  return traceSpans([root])
    .flatMap((node) =>
      node.span.events.flatMap((event, index) => {
        if (event.name !== 'theorem.guardrail') return [];
        const { attributes } = event;
        const stage = String(attributes.stage ?? '');
        const action = String(attributes.action ?? '');
        const actionMeta = eventOption('action', action);
        const check = typeof attributes.check === 'string' ? attributes.check : undefined;
        const provenance = isRecord(attributes.provenance) ? attributes.provenance : undefined;
        const reason = inlineContent(node.record, attributes.error);
        return [
          {
            id: `${node.id}:guardrail:${index}`,
            node,
            offsetMs: nanosToMs(event.timeUnixNano) - root.startMs,
            stage,
            stageLabel: eventOption('stage', stage)?.label ?? stage,
            ...(check && { checkLabel: eventOption('check', check)?.label ?? check }),
            action,
            actionLabel: actionMeta?.label ?? action,
            ...(actionMeta && { actionDoc: actionMeta.doc }),
            ...(typeof attributes.duration_ms === 'number' && {
              durationMs: attributes.duration_ms,
            }),
            hits: guardrailHits(attributes.hits),
            ...(typeof provenance?.tool === 'string' && { tool: provenance.tool }),
            ...(typeof reason === 'string' && reason && { reason }),
          },
        ];
      }),
    )
    .sort((a, b) => a.offsetMs - b.offsetMs);
}

type Interval = [number, number];

function union(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [from, to] of sorted) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

function intervalsOf(nodes: readonly TraceNode[], types: ReadonlySet<string>): Interval[] {
  return nodes
    .filter((node) => types.has(node.meta.type))
    .map((node) => [node.startMs, node.startMs + node.durationMs]);
}

const MODEL_TYPES: ReadonlySet<string> = new Set(['call', 'response', 'decision']);
const TOOL_TYPES: ReadonlySet<string> = new Set(['tool']);

/**
 * Where a turn's time went: waiting on the model, running tools, guardrail
 * checks, host hooks, and everything else. Guardrail checks during a stream
 * come out of the model's time; the rest, like the hooks, out of the time
 * between calls.
 */
export interface TraceTimeSplit {
  model: number;
  tools: number;
  guardrails: number;
  hooks: number;
  other: number;
}

/** Milliseconds a span's events of `name` recorded under `key`. */
function eventMs(node: TraceNode, name: string, key: string): number {
  return node.span.events.reduce((total, event) => {
    const value = event.name === name ? event.attributes[key] : undefined;
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
}

/** Milliseconds all of `nodes`' events of `name` recorded under `key`. */
function eventsMs(nodes: readonly TraceNode[], name: string, key: string): number {
  return nodes.reduce((total, node) => total + eventMs(node, name, key), 0);
}

/**
 * Where a turn's time went. Guardrail checks and hooks run inside the turn's
 * gaps and inside tool calls; their recorded time moves out of those into
 * their own share, so the model and tools keep only their own work.
 */
function traceTimeSplit(root: TraceNode): TraceTimeSplit {
  // why: A host's call is its own root: the tool span is the whole trace.
  const spans = TOOL_TYPES.has(root.meta.type)
    ? [root, ...traceSpans(root.children)]
    : traceSpans(root.children);
  const model = intervalsOf(spans, MODEL_TYPES);
  const tools = intervalsOf(spans, TOOL_TYPES);
  const toolNodes = spans.filter((node) => TOOL_TYPES.has(node.meta.type));
  const streamGuard = spans.reduce((total, node) => {
    const value = node.span.attributes['theorem.guardrail.stream_ms'];
    return total + (typeof value === 'number' ? value : 0);
  }, 0);
  const modelMs = union(model);
  const covered = union([...model, ...tools]);
  // why: A tool that runs an agent holds that agent's model calls: their time is the model's, not the tool's too.
  const toolsMs = covered - modelMs;
  const toolGuard = Math.min(toolsMs, eventsMs(toolNodes, 'theorem.guardrail', 'duration_ms'));
  const toolHooks = Math.min(toolsMs - toolGuard, eventsMs(toolNodes, 'theorem.stage', 'hook_ms'));
  const between = Math.max(0, root.durationMs - covered);
  const turnGuard = Math.min(between, eventMs(root, 'theorem.guardrail', 'duration_ms'));
  const turnHooks = Math.min(between - turnGuard, eventMs(root, 'theorem.stage', 'hook_ms'));
  return {
    model: Math.max(0, modelMs - streamGuard),
    tools: toolsMs - toolGuard - toolHooks,
    guardrails: turnGuard + Math.min(streamGuard, modelMs) + toolGuard,
    hooks: turnHooks + toolHooks,
    other: between - turnGuard - turnHooks,
  };
}

/**
 * How quickly a turn answered and what its guardrails cost. Each value is
 * absent when the trace did not record it.
 */
export interface TraceLatency {
  /** From the turn's start to the first text the person saw. */
  firstTextMs?: number;
  /** Of that, the time guardrails held finished text back before showing it. */
  heldMs?: number;
  /** Output tokens per second of writing, from each call's first text to its end. */
  tokensPerSecond?: number;
  /** Guardrail checks the trace recorded, how long they took, and how many were not a plain pass. */
  guardrails?: { checks: number; ms: number; flagged: number };
}

const MS_PER_S = 1000;

function secondsAttribute(node: TraceNode, key: string): number | undefined {
  const value = node.span.attributes[key];
  return typeof value === 'number' ? value * MS_PER_S : undefined;
}

export function traceLatency(root: TraceNode): TraceLatency {
  const spans = traceSpans([root]);
  const calls = spans.filter((node) => MODEL_TYPES.has(node.meta.type));
  const firstTextMs = secondsAttribute(root, 'theorem.turn.time_to_first_text');
  const written = calls
    .map((node) => {
      const at = secondsAttribute(node, 'theorem.response.time_to_first_text');
      return at === undefined ? undefined : { node, at };
    })
    .filter((entry) => entry !== undefined);
  const firstWritten = Math.min(...written.map(({ node, at }) => node.startMs - root.startMs + at));
  let tokens = 0;
  let writingMs = 0;
  for (const { node, at } of written) {
    const output = node.span.attributes['gen_ai.usage.output_tokens'];
    if (typeof output !== 'number' || node.durationMs <= at) continue;
    tokens += output;
    writingMs += node.durationMs - at;
  }
  let checks = 0;
  let flagged = 0;
  let guardMs = 0;
  for (const node of spans) {
    let streamChecksMs = 0;
    for (const event of node.span.events) {
      if (event.name !== 'theorem.guardrail') continue;
      checks += 1;
      if (event.attributes.action !== 'allow') flagged += 1;
      const took = event.attributes.duration_ms;
      if (typeof took !== 'number') continue;
      guardMs += took;
      if (typeof event.attributes.runs === 'number') streamChecksMs += took;
    }
    // why: A call's stream checks carry their own time; the call's total adds only what they do not (a trace from before they did).
    const stream = node.span.attributes['theorem.guardrail.stream_ms'];
    if (typeof stream === 'number') guardMs += Math.max(0, stream - streamChecksMs);
  }
  return {
    ...(firstTextMs !== undefined && { firstTextMs }),
    ...(firstTextMs !== undefined &&
      Number.isFinite(firstWritten) && { heldMs: Math.max(0, firstTextMs - firstWritten) }),
    ...(writingMs > 0 && { tokensPerSecond: tokens / (writingMs / MS_PER_S) }),
    ...(checks > 0 && { guardrails: { checks, ms: guardMs, flagged } }),
  };
}

/** One row of the timeline: a span, how deep it sits, and its start and end from the turn's start. */
export interface TraceBar {
  node: TraceNode;
  depth: number;
  from: number;
  to: number;
}

export function traceBars(root: TraceNode): TraceBar[] {
  const bars: TraceBar[] = [];
  const walk = (node: TraceNode, depth: number) => {
    const from = node.startMs - root.startMs;
    bars.push({ node, depth, from, to: from + node.durationMs });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return bars;
}

/** How busy the model and the tools were across the turn, in `buckets` equal slices (0 to 1 each). */
export function traceActivity(
  root: TraceNode,
  buckets: number,
): { at: number; model: number; tools: number }[] {
  const spans = traceSpans(root.children);
  const model = intervalsOf(spans, MODEL_TYPES);
  const tools = intervalsOf(spans, TOOL_TYPES);
  const width = Math.max(root.durationMs, 1) / buckets;
  const share = (intervals: readonly Interval[], from: number, to: number) =>
    Math.min(
      1,
      union(
        intervals
          .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as Interval)
          .filter(([a, b]) => b > a),
      ) / width,
    );
  return Array.from({ length: buckets + 1 }, (_, index) => {
    const from = root.startMs + index * width;
    return {
      at: index * width,
      model: share(model, from, from + width),
      tools: share(tools, from, from + width),
    };
  });
}
