// invariant: Leaf module. Imports nothing from `src/guardrails/types.ts` or `src/kernel/`, so the
// vocabulary can be read by every layer without a cycle.

/** lexicon-exempt-file: authoring labels and descriptions for boundaries — not runtime user or model copy (P2) */

/** A record with one entry per key, typed by the keys it was built from. */
function recordOf<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
  return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

/**
 * The kinds of tool whose text the kernel reads, in the words a builder writes as a tool's
 * `type`. A provider builtin has none: the provider runs it and the kernel never reads its text.
 */
const TOOL_KINDS = ['function', 'http', 'mcp', 'agent'] as const;
/** One of {@linkcode TOOL_KINDS}. */
type ToolKind = (typeof TOOL_KINDS)[number];

/** The three places a tool's text crosses: what the model sends, what comes back, and its error text. */
const TOOL_CROSSINGS = ['tool_arguments', 'tool_output', 'tool_failure'] as const;
/** One of {@linkcode TOOL_CROSSINGS}. */
type ToolCrossing = (typeof TOOL_CROSSINGS)[number];

/** A tool crossing for one kind of tool, such as `tool_output_mcp`. */
type ToolBoundary = `${ToolCrossing}_${ToolKind}`;

/** The boundary where `crossing` happens for a `kind` tool. */
function toolBoundary<C extends ToolCrossing, K extends ToolKind>(
  crossing: C,
  kind: K,
): `${C}_${K}` {
  return `${crossing}_${kind}`;
}

/** Every tool boundary, each crossing in turn for every kind of tool. */
const TOOL_BOUNDARIES: readonly ToolBoundary[] = TOOL_CROSSINGS.flatMap((crossing) =>
  TOOL_KINDS.map((kind) => toolBoundary(crossing, kind)),
);

/** Where text reaches the model from the person or the host. */
const INBOUND_BOUNDARIES = [
  'user',
  'attachment',
  'voice',
  'slots',
  'context',
  'history',
  'injected',
  'system',
  'repair',
  'live_user',
] as const;

/** Where the model's own text reaches the person. */
const OUTBOUND_BOUNDARIES = ['reply', 'reply_structured', 'live_reply', 'thought'] as const;

/** Every place the kernel reads text as it crosses, in the order a turn meets them. */
const BOUNDARIES = [
  ...INBOUND_BOUNDARIES,
  ...TOOL_BOUNDARIES,
  ...OUTBOUND_BOUNDARIES,
] as const satisfies readonly string[];
/** One of {@linkcode BOUNDARIES}. */
type Boundary = (typeof BOUNDARIES)[number];

/** How a boundary is named and described to a builder. */
interface BoundaryMeta {
  label: string;
  /** What is read there. */
  doc: string;
}

const TOOL_KIND_LABELS: Readonly<Record<ToolKind, string>> = {
  function: 'function',
  http: 'HTTP',
  mcp: 'MCP',
  agent: 'agent',
};

const TOOL_CROSSING_META: Readonly<Record<ToolCrossing, (kind: string) => BoundaryMeta>> = {
  tool_arguments: (kind) => ({
    label: `Arguments to ${kind} tools`,
    doc: `What the model sends to a tool of type ${kind}.`,
  }),
  tool_output: (kind) => ({
    label: `Output of ${kind} tools`,
    doc: `What a tool of type ${kind} returns.`,
  }),
  tool_failure: (kind) => ({
    label: `Errors from ${kind} tools`,
    doc: `The error text of a tool of type ${kind} that failed.`,
  }),
};

function toolBoundaryMeta(): Record<ToolBoundary, BoundaryMeta> {
  const entries = TOOL_CROSSINGS.flatMap((crossing) =>
    TOOL_KINDS.map(
      (kind) =>
        [
          toolBoundary(crossing, kind),
          TOOL_CROSSING_META[crossing](TOOL_KIND_LABELS[kind]),
        ] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<ToolBoundary, BoundaryMeta>;
}

/** The label and description of every boundary. */
const BOUNDARY_META: Readonly<Record<Boundary, BoundaryMeta>> = {
  user: { label: 'User message', doc: 'The message the person typed.' },
  attachment: { label: 'Attachments', doc: 'The text of a file the person attached.' },
  voice: { label: 'Voice', doc: 'The transcript of what the person said.' },
  slots: { label: 'Slots', doc: 'The values the host fills into the prompt.' },
  context: { label: 'Context', doc: 'What the page or the host tells the model to know.' },
  history: { label: 'History', doc: 'Earlier messages the host replays.' },
  injected: { label: 'Stage messages', doc: 'Messages a host stage adds during the turn.' },
  system: {
    label: 'Turn system text',
    doc: 'Text the host adds to the system instruction for one turn.',
  },
  repair: {
    label: 'Repair',
    doc: 'A stopped reply and the reason, handed back to the model to try again.',
  },
  live_user: { label: 'Live message', doc: 'Text the person sends in a Live session.' },
  ...toolBoundaryMeta(),
  reply: { label: 'Reply', doc: 'The text the model says to the person.' },
  reply_structured: {
    label: 'Structured reply',
    doc: 'The structured output the model returns.',
  },
  live_reply: { label: 'Live reply', doc: 'What the model says in a Live session.' },
  thought: { label: 'Thoughts', doc: "The model's reasoning, where the host shows it." },
};

export type { Boundary, BoundaryMeta, ToolBoundary, ToolCrossing, ToolKind };
export {
  BOUNDARIES,
  BOUNDARY_META,
  INBOUND_BOUNDARIES,
  OUTBOUND_BOUNDARIES,
  recordOf,
  TOOL_BOUNDARIES,
  TOOL_KINDS,
  toolBoundary,
};
