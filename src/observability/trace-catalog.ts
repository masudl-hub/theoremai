/**
 * Trace catalog — what every span, attribute, event and value THEOREM records
 * means, in words a person reads.
 *
 * The kernel writes trace records; this module is the one place their
 * vocabulary is named and described, so a viewer (the playground's trace
 * panel, a host's own tooling) never invents wording for them. Option sets are
 * keyed by the kernel's own enum types, so a new stop kind, error kind or tool
 * outcome fails the type check until it is described here.
 *
 * A key with no entry is still a real attribute: viewers show it under its raw
 * name rather than hiding it.
 *
 * @module
 */

import type { ErrorKind } from '../guardrails/theorem-error.ts';
import type {
  GuardrailAction,
  GuardrailStage,
  Severity,
  ToolOrigin,
  TrustLevel,
} from '../guardrails/types.ts';
import type {
  CompactionMeter,
  CompactionTiming,
  KeySlot,
  ToolGateKind,
  ToolPermission,
  TurnStage,
  TurnStopKind,
} from '../kernel/schema.ts';
import type { StageAffordance } from '../kernel/stages.ts';
import type { SessionEventKind } from '../kernel/types.ts';
import type { TraceSpan } from './trace-span.ts';

/** How a value reads: the unit or shape a viewer formats it by. */
type TraceValueFormat =
  /** Free text, shown as is. */
  | 'text'
  /** An identifier: shown as is, in monospace. */
  | 'id'
  /** A plain count. */
  | 'number'
  /** A token count. */
  | 'tokens'
  /** Seconds. */
  | 'seconds'
  /** Milliseconds. */
  | 'milliseconds'
  /** US dollars. */
  | 'usd'
  | 'boolean'
  /** A list of strings. */
  | 'list'
  /** A structured value, shown as JSON. */
  | 'object'
  /** A `{ content_sha256 }` reference to text in the record's `content`. */
  | 'content'
  /** A `{ json_sha256 }` reference to JSON in the record's `content`. */
  | 'json'
  /** Semconv chat messages whose parts reference `content`. */
  | 'messages'
  /** Semconv message parts whose text references `content`. */
  | 'parts'
  /** A unix-nanosecond timestamp string. */
  | 'time';

/** The section of a span's attributes an attribute is listed under. */
type TraceAttributeGroup =
  | 'agent'
  | 'request'
  | 'response'
  | 'messages'
  | 'usage'
  | 'tool'
  | 'http'
  | 'error'
  | 'record'
  | 'part';

/** One value of a closed set. */
interface TraceOptionMeta {
  label: string;
  doc: string;
}

/** One attribute: its label, what it means, and how its value reads. */
interface TraceAttributeMeta {
  label: string;
  doc: string;
  format: TraceValueFormat;
  group: TraceAttributeGroup;
  /** Its values' meanings, when it holds one of a known set. */
  options?: Readonly<Record<string, TraceOptionMeta>>;
  /** The options name the common values only: another value is real and shows as is. */
  open?: true;
  /** For an `object`: what its keys mean (for a list of objects, each item's keys). */
  fields?: Readonly<Record<string, TraceAttributeMeta>>;
}

/** One span event: its label, what it records, and its own attributes. */
interface TraceEventMeta {
  label: string;
  doc: string;
  /** Keys this event carries. A key missing here reads from the span attribute catalog. */
  attributes: Readonly<Record<string, TraceAttributeMeta>>;
}

/** What a span is, and the thing it acted on (the model, tool or agent), when it names one. */
interface TraceSpanMeta {
  label: string;
  doc: string;
  subject?: string;
}

const TRACE_ATTRIBUTE_GROUPS: Readonly<Record<TraceAttributeGroup, TraceOptionMeta>> = {
  agent: { label: 'Agent', doc: 'Which agent ran, for which conversation, and how it ended.' },
  request: { label: 'Request', doc: 'What THEOREM asked the provider for.' },
  response: { label: 'Response', doc: 'What the provider said about its answer.' },
  messages: { label: 'Messages', doc: 'What was read and written, stored by hash.' },
  usage: { label: 'Usage', doc: 'Tokens and cost, as reported or estimated.' },
  tool: { label: 'Tool', doc: 'The tool call, its arguments, and how it settled.' },
  http: { label: 'HTTP', doc: 'One HTTP try: where it went and what came back.' },
  error: { label: 'Error', doc: 'Why it failed.' },
  record: { label: 'Record', doc: 'What this record kept and how it was taken.' },
  part: { label: 'Part', doc: 'Facts about one message part.' },
};

/** Span status meanings (OpenTelemetry's three codes). */
const TRACE_STATUS: Readonly<Record<TraceSpan['status']['code'], TraceOptionMeta>> = {
  OK: { label: 'OK', doc: 'Finished as intended.' },
  ERROR: { label: 'Error', doc: 'Failed; the error kind says why.' },
  UNSET: {
    label: 'Stopped',
    doc: 'Stopped on purpose (cancelled, waiting for approval, paused) or ended with no verdict.',
  },
};

/** A record's and a span's own fields, beside their attributes. */
const TRACE_FIELDS = {
  resource: {
    label: 'Host resource',
    doc: 'Attributes the host set for its process (observability.resource), e.g. service.name.',
  },
  metadata: {
    label: 'Request metadata',
    doc: 'The metadata the host passed on the request, untouched.',
  },
  traceId: { label: 'Trace ID', doc: 'Shared by every span of one trace.' },
  spanId: { label: 'Span ID', doc: "This span's id." },
  status: { label: 'Status', doc: 'How the span ended.' },
  start: { label: 'Started', doc: 'When the span started.' },
  duration: { label: 'Duration', doc: 'From start to end, on the clock the record names.' },
  events: { label: 'Events', doc: 'What happened during the span, in order.' },
  links: { label: 'Links', doc: 'Earlier traces this span follows.' },
} satisfies Record<string, TraceOptionMeta>;

// ── value sets ──────────────────────────────────────

const STOP_KINDS: Readonly<Record<TurnStopKind | 'go_away', TraceOptionMeta>> = {
  completed: { label: 'Completed', doc: 'The model finished its answer.' },
  length: { label: 'Hit output limit', doc: 'The model stopped at its output token limit.' },
  tool: {
    label: 'Handed tool to host',
    doc: 'Stopped to hand a tool call back to the host. Deprecated: approval now stops as “Waiting for approval”.',
  },
  gate: {
    label: 'Waiting for approval',
    doc: 'A tool call needs confirmation, permission or sign-in before it runs; the host resumes it.',
  },
  filtered: {
    label: 'Filtered',
    doc: 'A safety filter or the output guardrail held the answer back.',
  },
  provider_error: { label: 'Provider error', doc: 'The provider reported an error.' },
  cancelled: { label: 'Cancelled', doc: 'The user or host stopped it.' },
  stream_incomplete: {
    label: 'Stream cut off',
    doc: "The provider's stream ended before the answer was complete.",
  },
  interrupted: { label: 'Interrupted', doc: 'The user spoke over a Live response.' },
  generation_complete: {
    label: 'Generation complete',
    doc: 'Live: the model finished generating this response; the turn may still be open.',
  },
  go_away: {
    label: 'Closed by provider',
    doc: 'Live: the provider warned the session would end, then closed it.',
  },
};

const ERROR_KIND_OPTIONS: Readonly<Record<ErrorKind, TraceOptionMeta>> = {
  config: { label: 'Setup', doc: 'The profile, tool, or schema is set up wrong.' },
  request: { label: 'Host request', doc: 'The host called THEOREM wrongly.' },
  input: { label: 'User input', doc: 'The user sent input the profile does not accept.' },
  action: { label: 'Not allowed', doc: 'The user asked for something the profile does not allow.' },
  auth: {
    label: 'Credentials',
    doc: 'A missing or rejected credential, or an account that cannot be billed.',
  },
  rate_limit: { label: 'Rate limit', doc: 'Too many requests, or a quota used up.' },
  unsupported: { label: 'Unsupported', doc: 'The model or route cannot serve this request.' },
  unavailable: { label: 'Unavailable', doc: 'The provider is down or overloaded.' },
  bad_response: {
    label: 'Unusable response',
    doc: 'The provider answered with something that cannot be used.',
  },
  network: { label: 'Network', doc: 'The request never reached the provider.' },
  timeout: { label: 'Timeout', doc: 'The model took longer than the host allowed.' },
  safety: { label: 'Safety', doc: 'THEOREM or the provider held the reply back.' },
  blocked: {
    label: 'Blocked',
    doc: "A guardrail or host policy stopped one of the agent's steps.",
  },
  declined: { label: 'Declined', doc: "The user declined one of the agent's steps." },
  failed: { label: 'Failed', doc: "One of the agent's steps ran and failed." },
  cancelled: { label: 'Cancelled', doc: 'The user or host stopped the turn.' },
  internal: { label: 'Internal', doc: 'A THEOREM invariant broke.' },
};

/** `error.type`: an error kind, or the failing stop when nothing named a kind. An HTTP status or exception name shows as is. */
const ERROR_TYPE_OPTIONS: Readonly<Record<string, TraceOptionMeta>> = {
  ...ERROR_KIND_OPTIONS,
  provider_error: STOP_KINDS.provider_error,
  stream_incomplete: STOP_KINDS.stream_incomplete,
};

const TOOL_OUTCOMES: Readonly<
  Record<'ok' | 'error' | 'denied' | 'gated' | 'paused' | 'cancelled', TraceOptionMeta>
> = {
  ok: { label: 'Succeeded', doc: 'The tool ran and returned a result.' },
  error: { label: 'Failed', doc: 'The tool ran and failed, or could not run.' },
  denied: { label: 'Denied', doc: 'A guardrail, a hook or the user refused the call.' },
  gated: {
    label: 'Waiting for approval',
    doc: 'The call needs confirmation, permission or sign-in; it has not run.',
  },
  paused: { label: 'Paused', doc: 'The call was handed back to the host to finish.' },
  cancelled: { label: 'Cancelled', doc: 'The turn was stopped before the call settled.' },
};

const TOOL_ORIGIN_OPTIONS: Readonly<Record<ToolOrigin, TraceOptionMeta>> = {
  local: { label: 'Host code', doc: 'TypeScript the host registered, run in-process.' },
  builtin: { label: 'Built-in', doc: 'A tool THEOREM ships.' },
  http: { label: 'HTTP', doc: 'A remote HTTP endpoint.' },
  mcp: { label: 'MCP', doc: 'A tool on an MCP server.' },
  delegated: { label: 'Another agent', doc: 'A specialist agent the tool ran.' },
};

const TOOL_PERMISSION_OPTIONS: Readonly<Record<ToolPermission, TraceOptionMeta>> = {
  auto: { label: 'Automatic', doc: 'Runs without asking.' },
  session_consent: { label: 'Ask once', doc: 'Asks once per session, then remembers the answer.' },
  always_confirm: { label: 'Always ask', doc: 'Asks before every call.' },
};

const KEY_SLOT_OPTIONS: Readonly<Record<KeySlot, TraceOptionMeta>> = {
  slotA: { label: 'Key A', doc: "The host vault's first key slot." },
  slotB: { label: 'Key B', doc: "The host vault's second key slot." },
  slotC: { label: 'Key C', doc: "The host vault's third key slot." },
  paid: { label: 'Paid key', doc: 'The paid key a refused call overflowed to.' },
};

const LINK_KINDS: Readonly<Record<'resume' | 'continue' | 'retry', TraceOptionMeta>> = {
  resume: { label: 'Resumes', doc: 'Picks up a call that stopped for approval.' },
  continue: { label: 'Continues', doc: 'Continues an answer that stopped early.' },
  retry: { label: 'Retries', doc: 'Runs a failed turn again.' },
};

const OPERATIONS: Readonly<
  Record<'invoke_agent' | 'chat' | 'generate_content' | 'execute_tool', TraceOptionMeta>
> = {
  invoke_agent: { label: 'Run agent', doc: 'One turn of an agent, or one Live session.' },
  chat: { label: 'Chat', doc: 'A model call over a chat-completions API.' },
  generate_content: { label: 'Generate content', doc: 'A model call over a Gemini API.' },
  execute_tool: { label: 'Run tool', doc: 'A tool call THEOREM ran.' },
};

const OUTPUT_TYPES: Readonly<Record<'text' | 'json' | 'image' | 'speech', TraceOptionMeta>> = {
  text: { label: 'Text', doc: 'The model answers in text.' },
  json: { label: 'JSON', doc: 'The model answers with structured JSON.' },
  image: { label: 'Image', doc: 'The model answers with an image.' },
  speech: { label: 'Speech', doc: 'The model answers in audio.' },
};

const PROVIDERS: Readonly<Record<'gcp.gemini' | 'openrouter', TraceOptionMeta>> = {
  'gcp.gemini': { label: 'Google Gemini', doc: "Google's Gemini API." },
  openrouter: { label: 'OpenRouter', doc: 'The OpenRouter gateway.' },
};

const USAGE_SIDES: Readonly<Record<'input' | 'output', TraceOptionMeta>> = {
  input: { label: 'Input', doc: 'Tokens the model read.' },
  output: { label: 'Output', doc: 'Tokens the model wrote.' },
};

const TRANSCRIPT_SOURCES: Readonly<
  Record<'input_transcription' | 'output_transcription', TraceOptionMeta>
> = {
  input_transcription: {
    label: 'What the provider heard',
    doc: "The provider's transcript of the user's audio.",
  },
  output_transcription: {
    label: 'Transcript of the reply',
    doc: "The provider's transcript of the model's spoken answer.",
  },
};

const TURN_STAGE_OPTIONS: Readonly<Record<TurnStage, TraceOptionMeta>> = {
  pre_turn: { label: 'Before the turn', doc: 'Before the first model call.' },
  pre_tool: { label: 'Before a tool', doc: 'Before a tool call runs.' },
  post_tool: { label: 'After a tool', doc: 'After a tool call settles.' },
  before_end: { label: 'Before the end', doc: 'Before the turn delivers its final answer.' },
  post_turn: { label: 'After the turn', doc: 'After the turn has ended.' },
};

const AFFORDANCES: Readonly<Record<StageAffordance, TraceOptionMeta>> = {
  inject: { label: 'Injected', doc: 'Added messages to the conversation.' },
  abort: { label: 'Aborted', doc: 'Stopped the turn.' },
  deny: { label: 'Denied', doc: 'Refused a tool call.' },
  confirm: { label: 'Asked to confirm', doc: 'Required confirmation before a tool call.' },
  mutate: { label: 'Changed', doc: 'Changed the tool call or its result.' },
};

const GUARDRAIL_STAGE_OPTIONS: Readonly<Record<GuardrailStage, TraceOptionMeta>> = {
  input: { label: 'User input', doc: 'Text the user sent.' },
  history: { label: 'History', doc: 'Earlier messages sent back to the model.' },
  system: { label: 'System instructions', doc: "The profile's or host's instructions." },
  attachment: { label: 'Attachment', doc: 'A file the user attached.' },
  tool_call: { label: 'Tool call', doc: 'Arguments the model sent to a tool.' },
  tool_result: { label: 'Tool result', doc: 'What a tool returned.' },
  output_delta: { label: 'Streaming output', doc: 'The answer as it streamed.' },
  output_final: { label: 'Final output', doc: 'The whole answer.' },
  network: { label: 'Network', doc: 'A URL the agent was about to reach.' },
  live_inbound: { label: 'Live inbound', doc: 'What arrived from a Live session.' },
  live_outbound: { label: 'Live outbound', doc: 'What was sent into a Live session.' },
  trace: { label: 'Trace', doc: 'Text being written to the trace.' },
};

const TRUST_OPTIONS: Readonly<Record<TrustLevel, TraceOptionMeta>> = {
  trusted: { label: 'Trusted', doc: "The profile's own text, written at author time." },
  assembled: { label: 'Assembled', doc: 'Built by the host each turn; may carry user data.' },
  untrusted: {
    label: 'Untrusted',
    doc: 'User input, tool results, attachments, or another agent.',
  },
};

const GUARDRAIL_ACTIONS: Readonly<Record<GuardrailAction, TraceOptionMeta>> = {
  allow: { label: 'Allowed', doc: 'Checked and let through unchanged.' },
  redact: { label: 'Redacted', doc: 'The matched text was replaced.' },
  flag: { label: 'Flagged', doc: 'Recorded; nothing was changed.' },
  block: { label: 'Blocked', doc: 'The step was stopped.' },
};

const SEVERITY_OPTIONS: Readonly<Record<Severity, TraceOptionMeta>> = {
  info: { label: 'Info', doc: 'Noted only.' },
  low: { label: 'Low', doc: 'Low risk.' },
  medium: { label: 'Medium', doc: 'Medium risk.' },
  high: { label: 'High', doc: 'High risk.' },
};

const GATE_KINDS: Readonly<Record<ToolGateKind, TraceOptionMeta>> = {
  confirmation: { label: 'Confirmation', doc: 'The user must confirm this call.' },
  permission: { label: 'Permission', doc: 'The user must allow this tool.' },
  auth: { label: 'Sign-in', doc: 'The tool needs a credential the user must provide.' },
};

const RETRY_REASONS: Readonly<Record<'egress' | 'validation', TraceOptionMeta>> = {
  egress: {
    label: 'Output guardrail',
    doc: 'The output guardrail sent the answer back to the model.',
  },
  validation: { label: 'Invalid JSON', doc: 'The structured output did not match its schema.' },
};

const COMPACTION_TIMING_OPTIONS: Readonly<Record<CompactionTiming, TraceOptionMeta>> = {
  before: { label: 'Before the turn', doc: 'Compacts before the turn runs.' },
  after: { label: 'After the turn', doc: 'Signals the host to compact after the turn.' },
};

const COMPACTION_METER_OPTIONS: Readonly<Record<CompactionMeter, TraceOptionMeta>> = {
  history: { label: 'History', doc: 'Counts tokens across earlier turns.' },
  input: {
    label: 'Whole input',
    doc: "Counts the turn's whole input: instructions, history and attachments.",
  },
};

/** `theorem.session` kinds: the provider's session signals (a finished response is its own record), and THEOREM's socket facts. */
const SESSION_KINDS: Readonly<
  Record<
    | Exclude<SessionEventKind, 'turn_complete'>
    | 'voice_activity'
    | 'session_resumption'
    | 'setup_complete'
    | 'key_overflow'
    | 'closed',
    TraceOptionMeta
  >
> = {
  closing_soon: { label: 'Closing soon', doc: 'The provider warned the session will end.' },
  ended: { label: 'Ended', doc: 'The provider ended the session after warning it would.' },
  waiting_for_input: { label: 'Waiting for input', doc: 'The model is waiting for the user.' },
  working: { label: 'Working', doc: 'The model is thinking or waiting on a tool.' },
  idle: { label: 'Idle', doc: 'The model finished everything it was doing.' },
  voice_activity: { label: 'Voice activity', doc: 'The provider heard speech start or stop.' },
  session_resumption: {
    label: 'Resumption update',
    doc: 'The provider said whether the session can be resumed.',
  },
  setup_complete: { label: 'Setup complete', doc: 'The provider accepted the session setup.' },
  key_overflow: {
    label: 'Switched to paid key',
    doc: 'The first key was refused for quota at setup; the session reopened on the paid key.',
  },
  closed: { label: 'Socket closed', doc: 'The session socket closed.' },
};

const CLOSE_INITIATORS: Readonly<Record<'host' | 'provider' | 'theorem', TraceOptionMeta>> = {
  host: { label: 'Host', doc: 'The host closed the session.' },
  provider: { label: 'Provider', doc: 'The provider closed the socket.' },
  theorem: { label: 'THEOREM', doc: 'THEOREM closed the socket.' },
};

const CLOCK_OPTIONS: Readonly<Record<'io', TraceOptionMeta>> = {
  io: {
    label: 'Moves at I/O only',
    doc: 'Recorded in a Cloudflare Worker, whose clock only moves at I/O: time spent computing reads as zero.',
  },
};

// ── span attributes ─────────────────────────────────

function attr(
  group: TraceAttributeGroup,
  label: string,
  format: TraceValueFormat,
  doc: string,
  options?: Readonly<Record<string, TraceOptionMeta>>,
): TraceAttributeMeta {
  return options ? { label, doc, format, group, options } : { label, doc, format, group };
}

/** An `object` attribute whose keys are described. */
function fields(
  group: TraceAttributeGroup,
  label: string,
  doc: string,
  keys: Readonly<Record<string, TraceAttributeMeta>>,
): TraceAttributeMeta {
  return { label, doc, format: 'object', group, fields: keys };
}

const BOOLEAN_SIDES = {
  input: attr('request', 'Input', 'boolean', "Transcribe the user's audio."),
  output: attr('request', 'Output', 'boolean', "Transcribe the model's audio."),
};

const SPAN_ATTRIBUTES: Readonly<Record<string, TraceAttributeMeta>> = {
  // agent
  'gen_ai.operation.name': attr('agent', 'Operation', 'text', 'What this span did.', OPERATIONS),
  'gen_ai.agent.name': attr('agent', 'Agent', 'id', 'The profile that ran.'),
  'gen_ai.conversation.id': attr(
    'agent',
    'Conversation',
    'id',
    'The conversation id the host passed; absent when it passed none.',
  ),
  'gen_ai.conversation.compacted': attr(
    'agent',
    'History compacted',
    'boolean',
    'Compaction summarized earlier messages in this turn.',
  ),
  'theorem.stop.kind': attr(
    'agent',
    'Stop reason',
    'text',
    'Why it ended. Absent when it failed before any stop.',
    STOP_KINDS,
  ),
  'theorem.attempts': attr(
    'agent',
    'Attempts',
    'number',
    'Times the turn ran its model calls, counting a retry after a guardrail or invalid JSON.',
  ),
  'theorem.steps': attr('agent', 'Model calls', 'number', 'Model calls made (Live: responses).'),
  'theorem.step': attr('agent', 'Step', 'number', 'Which model call of the turn this is, from 1.'),
  'theorem.attempt': attr(
    'agent',
    'Attempt',
    'number',
    'Which attempt of the turn made this call.',
  ),
  'theorem.request.effort': attr('agent', 'Effort', 'text', 'The effort the host asked for.'),
  'theorem.request.model_select': attr(
    'agent',
    'Model asked for',
    'id',
    'The model the host asked for, by alias.',
  ),
  'theorem.project.id': attr('agent', 'Project', 'id', 'The project id the host passed.'),
  'theorem.link.kind': attr(
    'agent',
    'Link',
    'text',
    'How this span follows an earlier trace.',
    LINK_KINDS,
  ),

  // request
  'gen_ai.provider.name': {
    ...attr(
      'request',
      'Provider',
      'id',
      'Who served the call; a local server by its declared name. Absent when unknown.',
      PROVIDERS,
    ),
    open: true,
  },
  'gen_ai.request.model': attr('request', 'Model sent', 'id', 'The model id sent to the provider.'),
  'theorem.model.id': attr('request', 'Model alias', 'id', "The profile's name for the model."),
  'gen_ai.request.stream': attr(
    'request',
    'Streamed',
    'boolean',
    'The call streamed its answer. Absent means it did not.',
  ),
  'gen_ai.request.temperature': attr('request', 'Temperature', 'number', 'As requested.'),
  'gen_ai.request.max_tokens': attr('request', 'Max output tokens', 'tokens', 'As requested.'),
  'gen_ai.request.reasoning.level': attr('request', 'Thinking level', 'text', 'As requested.'),
  'gen_ai.request.previous_response.id': attr(
    'request',
    'Continues response',
    'id',
    'The stored response this call continues.',
  ),
  'gen_ai.output.type': attr(
    'request',
    'Output type',
    'text',
    'What kind of answer was asked for.',
    OUTPUT_TYPES,
  ),
  'theorem.key_slot': attr(
    'request',
    'API key',
    'text',
    'The vault key slot that finally answered.',
    KEY_SLOT_OPTIONS,
  ),
  'theorem.request.builtins': attr(
    'request',
    'Provider tools',
    'list',
    'Tools the provider runs itself (search, maps, code), as requested.',
  ),
  'theorem.request.store': attr(
    'request',
    'Stored by provider',
    'boolean',
    'Asked the provider to keep the response for a later continuation.',
  ),
  'theorem.request.summaries': attr(
    'request',
    'Thought summaries',
    'text',
    'Asked for summaries of the model’s thinking.',
  ),
  'theorem.request.structured': attr(
    'request',
    'Structured output',
    'object',
    'The JSON schema the answer must match.',
  ),
  'theorem.request.session_id': attr(
    'request',
    'Session',
    'id',
    'The provider session this call ran in.',
  ),
  'theorem.request.cache': fields('request', 'Cache', 'The prompt cache, as requested.', {
    mode: attr('request', 'Mode', 'text', 'How the prompt cache is used.'),
    ttl: attr('request', 'Lifetime', 'text', 'How long a cache entry lives.'),
  }),
  'theorem.request.image': fields('request', 'Image settings', 'The image asked for.', {
    mime_type: attr('request', 'Format', 'text', 'The image file type.'),
    aspect_ratio: attr('request', 'Aspect ratio', 'text', 'Width to height.'),
    size: attr('request', 'Size', 'text', 'The image size.'),
    include_text: attr('request', 'With text', 'boolean', 'Text may come back beside the image.'),
  }),
  'theorem.request.speech': fields('request', 'Speech settings', 'The audio asked for.', {
    voice: attr('request', 'Voice', 'text', 'The voice.'),
    format: attr('request', 'Format', 'text', 'The audio format.'),
  }),
  'theorem.request.live': fields('request', 'Live settings', 'The Live session setup, as sent.', {
    voice: attr('request', 'Voice', 'text', 'The voice the model speaks in.'),
    vad: fields('request', 'Voice detection', 'How the provider hears speech start and stop.', {
      activity_handling: attr(
        'request',
        'On speech',
        'text',
        'What the model does when the user starts speaking.',
      ),
      start_sensitivity: attr(
        'request',
        'Start sensitivity',
        'text',
        'How readily speech counts as started.',
      ),
      end_sensitivity: attr(
        'request',
        'End sensitivity',
        'text',
        'How readily speech counts as ended.',
      ),
      prefix_padding_ms: attr(
        'request',
        'Lead-in',
        'milliseconds',
        'Speech needed before it counts as started.',
      ),
      silence_duration_ms: attr(
        'request',
        'Silence to end',
        'milliseconds',
        'Silence needed before speech counts as ended.',
      ),
    }),
    session_resumption: attr(
      'request',
      'Resumable',
      'boolean',
      'Asked for handles to resume the session later.',
    ),
    context_compression: fields(
      'request',
      'Context compression',
      'How the provider shrinks a long session.',
    ),
    proactive_audio: attr(
      'request',
      'Proactive audio',
      'boolean',
      'The model may stay silent or ignore input that is not for it.',
    ),
    transcription: fields(
      'request',
      'Transcription',
      {
        mechanism: attr('request', 'Mechanism', 'text', 'How the context is shrunk.'),
        trigger_tokens: attr(
          'request',
          'Trigger',
          'tokens',
          'Context size that starts compression.',
        ),
        target_tokens: attr('request', 'Keep', 'tokens', 'Context size kept after compressing.'),
      },
      'Which audio the provider transcribes.',
      BOOLEAN_SIDES,
    ),
    resumed: attr(
      'request',
      'Resumed',
      'boolean',
      'The session resumed an earlier one. The resumption handle is a credential and is never recorded.',
    ),
  }),
  'theorem.input.sent_from': attr(
    'request',
    'Sent from message',
    'number',
    'Where in the input messages the request body starts; earlier ones the provider already held.',
  ),

  // response
  'gen_ai.response.id': attr('response', 'Response ID', 'id', "The provider's id for its answer."),
  'gen_ai.response.model': attr(
    'response',
    'Model that answered',
    'id',
    'The model the provider says answered.',
  ),
  'gen_ai.response.finish_reasons': attr(
    'response',
    'Provider finish reason',
    'list',
    "The provider's own reason for stopping. Absent when the call was stopped.",
  ),
  'gen_ai.response.status': attr(
    'response',
    'Provider status',
    'text',
    "The provider's own status for the answer. Absent when the call was stopped.",
  ),
  'gen_ai.response.time_to_first_chunk': attr(
    'response',
    'Time to first chunk',
    'seconds',
    'From the start of the successful HTTP try to its first chunk.',
  ),

  // messages
  'gen_ai.system_instructions': attr(
    'messages',
    'System instructions',
    'parts',
    'The instructions the model read.',
  ),
  'gen_ai.tool.definitions': attr(
    'messages',
    'Tool definitions',
    'content',
    'The tools offered to the model, as sent.',
  ),
  'gen_ai.input.messages': attr(
    'messages',
    'Input',
    'messages',
    "On a turn: the user's new input. On a model call: everything the model read.",
  ),
  'gen_ai.output.messages': attr(
    'messages',
    'Output',
    'messages',
    'On a turn: what the host received. On a model call: what the model produced.',
  ),
  'theorem.output.delivered': attr(
    'messages',
    'Delivered',
    'messages',
    'What the host received of this Live response.',
  ),
  'theorem.error.public': attr(
    'error',
    'Error the user saw',
    'content',
    'The worded error the caller received.',
  ),

  // usage
  'gen_ai.usage.input_tokens': attr('usage', 'Input tokens', 'tokens', 'Tokens the model read.'),
  'gen_ai.usage.output_tokens': attr('usage', 'Output tokens', 'tokens', 'Tokens the model wrote.'),
  'gen_ai.usage.reasoning.output_tokens': attr(
    'usage',
    'Thinking tokens',
    'tokens',
    'Output tokens spent thinking.',
  ),
  'gen_ai.usage.cache_read.input_tokens': attr(
    'usage',
    'Cached input tokens',
    'tokens',
    'Input tokens read from the prompt cache.',
  ),
  'gen_ai.usage.cache_write.input_tokens': attr(
    'usage',
    'Cache write tokens',
    'tokens',
    'Input tokens written to the prompt cache.',
  ),
  'theorem.usage.tool_use.input_tokens': attr(
    'usage',
    'Tool-use input tokens',
    'tokens',
    'Input tokens Google counts for tool use; already inside input tokens.',
  ),
  'theorem.usage.grounding': fields('usage', 'Grounding', 'Grounding tool uses, per tool.', {
    type: attr('usage', 'Tool', 'id', "The provider's name for the tool."),
    count: attr('usage', 'Uses', 'number', 'Times the tool ran.'),
    search_query_count: attr('usage', 'Searches', 'number', 'Search queries it ran.'),
  }),
  'theorem.usage.cost_usd': attr(
    'usage',
    'Cost',
    'usd',
    'As reported. Absent when no call reported a cost.',
  ),
  'theorem.usage.upstream_cost_usd': attr(
    'usage',
    'Upstream cost',
    'usd',
    "The upstream provider's cost, as a gateway reported it.",
  ),
  'theorem.usage.cost_partial': attr(
    'usage',
    'Cost is partial',
    'boolean',
    'Only some calls reported a cost.',
  ),
  'theorem.usage.estimated': attr(
    'usage',
    'Estimated',
    'list',
    'Sides whose token counts THEOREM estimated rather than the provider reporting them.',
    USAGE_SIDES,
  ),
  'theorem.usage.unknown_media': fields(
    'usage',
    'Uncounted media',
    'Media items no counting rule covered, so their tokens are missing from the estimate.',
    {
      input: attr('usage', 'Input', 'number', 'Uncounted media the model read.'),
      output: attr('usage', 'Output', 'number', 'Uncounted media the model wrote.'),
    },
  ),

  // tool
  'gen_ai.tool.name': attr('tool', 'Tool', 'id', 'The tool called.'),
  'gen_ai.tool.call.id': attr('tool', 'Call ID', 'id', "The call's id."),
  'gen_ai.tool.type': attr('tool', 'Tool type', 'text', 'function for a registered tool.'),
  'gen_ai.tool.call.arguments': attr(
    'tool',
    'Arguments',
    'content',
    'The arguments exactly as the model sent them.',
  ),
  'gen_ai.tool.call.result': attr(
    'tool',
    'Result',
    'content',
    'What the model reads back, after formatting and the tool-result guardrail.',
  ),
  'theorem.tool.call.result.parts': attr(
    'tool',
    'Result media',
    'parts',
    'Media and other parts the result carried.',
  ),
  'theorem.tool.data': attr('tool', 'Raw output', 'json', "The tool's output before formatting."),
  'theorem.tool.outcome': attr('tool', 'Outcome', 'text', 'How the call settled.', TOOL_OUTCOMES),
  'theorem.tool.origin': attr(
    'tool',
    'Origin',
    'text',
    'Where the tool runs, which sets how far its result is trusted.',
    TOOL_ORIGIN_OPTIONS,
  ),
  'theorem.tool.permission': attr(
    'tool',
    'Permission',
    'text',
    "The tool's permission tier.",
    TOOL_PERMISSION_OPTIONS,
  ),
  'theorem.tool.approved': attr(
    'tool',
    'Approved',
    'boolean',
    'The host resumed this call with approval.',
  ),
  'theorem.tool.failure.code': attr(
    'error',
    'Failure code',
    'id',
    "The tool's code for the failure, e.g. malformed_arguments.",
  ),
  'theorem.cutout.input.sha256': attr(
    'tool',
    'Input hash',
    'id',
    "The host's hash of what it sent to the cutout.",
  ),
  'theorem.cutout.output.sha256': attr(
    'tool',
    'Output hash',
    'id',
    "The host's hash of what came back.",
  ),

  // http
  'http.request.method': attr('http', 'Method', 'text', 'The HTTP method.'),
  'server.address': attr('http', 'Host', 'id', 'The server the try went to.'),
  'url.path': attr('http', 'Path', 'id', 'The URL path. The query is never recorded.'),
  'http.response.status_code': attr('http', 'Status code', 'number', 'The HTTP status returned.'),
  'http.request.resend_count': attr(
    'http',
    'Retry number',
    'number',
    '0 for the first try, then 1, 2, … for each retry.',
  ),
  'theorem.retry.backoff_ms': attr(
    'http',
    'Wait before retry',
    'milliseconds',
    'How long THEOREM waited after the previous try.',
  ),

  // error
  'error.type': {
    ...attr(
      'error',
      'Error kind',
      'text',
      'Why it failed: an error kind, the failing stop, or on an HTTP try its status or exception name.',
      ERROR_TYPE_OPTIONS,
    ),
    open: true,
  },
  'exception.type': attr('error', 'Exception', 'id', 'The class or kind of what was thrown.'),
  'exception.message': attr('error', 'Message', 'content', 'The exception message, scrubbed.'),

  // record
  'theorem.record.include': attr(
    'record',
    'Included',
    'list',
    'What this record kept. A field left out because it was off reads as not recorded, never as did not happen.',
  ),
  'theorem.record.scrub': attr(
    'record',
    'Scrubbed',
    'list',
    'What was removed from stored text before it was hashed.',
  ),
  'theorem.clock': attr(
    'record',
    'Clock',
    'text',
    'How the times in this record were taken.',
    CLOCK_OPTIONS,
  ),

  // part
  'theorem.source': attr(
    'part',
    'Source',
    'text',
    'Where this text came from, when it is not the model’s own.',
    TRANSCRIPT_SOURCES,
  ),
  'theorem.interim': attr(
    'part',
    'Interim',
    'boolean',
    'An interim transcript, not the final one.',
  ),
  'theorem.observed_end': attr(
    'part',
    'Seen at',
    'time',
    'When THEOREM saw this provider-run step whole.',
  ),
  'theorem.partial': attr(
    'part',
    'Incomplete',
    'boolean',
    'The provider sent this step incomplete.',
  ),
};

/** Modality token counts: `{gen_ai|theorem}.usage.<modality>.<input|output>_tokens`. */
const MODALITY_USAGE = /^(?:gen_ai|theorem)\.usage\.([a-z]+)\.(input|output)_tokens$/;
/** Recorded headers: `http.<request|response>.header.<name>`. */
const HEADER = /^http\.(request|response)\.header\.(.+)$/;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** What an attribute key means; `undefined` for a key THEOREM does not write. */
function traceAttributeMeta(key: string): TraceAttributeMeta | undefined {
  const known = SPAN_ATTRIBUTES[key];
  if (known) return known;
  const usage = MODALITY_USAGE.exec(key);
  if (usage) {
    const [, modality = '', side = ''] = usage;
    return attr(
      'usage',
      `${capitalize(modality)} ${side} tokens`,
      'tokens',
      `${capitalize(side)} tokens that were ${modality}, as the provider reported them.`,
    );
  }
  const header = HEADER.exec(key);
  if (header) {
    const [, direction = '', name = ''] = header;
    return attr(
      'http',
      `${capitalize(direction)} header ${name}`,
      'list',
      `The ${direction} header, as sent. A key, auth, cookie, secret or token header is [redacted].`,
    );
  }
  return undefined;
}

// ── events ──────────────────────────────────────────

const HITS = fields('error', 'Hits', 'Each rule that matched.', {
  rule: attr('error', 'Rule', 'id', 'The rule that matched.'),
  severity: attr(
    'error',
    'Severity',
    'text',
    'How serious the rule says a match is.',
    SEVERITY_OPTIONS,
  ),
  start: attr('error', 'From', 'number', 'Where the match starts in the checked text.'),
  end: attr('error', 'To', 'number', 'Where the match ends in the checked text.'),
  match: attr(
    'error',
    'Match',
    'text',
    'The matched text, exact. Kept only when the profile records match previews.',
  ),
});

const TRACE_EVENTS: Readonly<Record<string, TraceEventMeta>> = {
  'theorem.stage': {
    label: 'Hook',
    doc: 'A stage in the turn where host hooks could act.',
    attributes: {
      stage: attr('agent', 'Stage', 'text', 'Where in the turn.', TURN_STAGE_OPTIONS),
      affordance: attr(
        'agent',
        'Applied',
        'list',
        'What the hooks did; empty when they did nothing.',
        AFFORDANCES,
      ),
      hook_ms: attr(
        'agent',
        'Hook time',
        'milliseconds',
        'Time the hooks took; absent when none ran.',
      ),
      warnings: attr('error', 'Warnings', 'list', 'Warning codes the hooks raised.'),
    },
  },
  'theorem.guardrail': {
    label: 'Guardrail',
    doc: 'A guardrail checked some text and acted on it.',
    attributes: {
      stage: attr('agent', 'Checked', 'text', 'Which text was checked.', GUARDRAIL_STAGE_OPTIONS),
      trust: attr('agent', 'Trust', 'text', 'How far that text is trusted.', TRUST_OPTIONS),
      action: attr('agent', 'Action', 'text', 'What the guardrail did.', GUARDRAIL_ACTIONS),
      hits: HITS,
      provenance: fields('agent', 'Came from', 'Where the checked text came from.', {
        origin: attr(
          'tool',
          'Origin',
          'text',
          'Where the tool runs, which sets how far its result is trusted.',
          TOOL_ORIGIN_OPTIONS,
        ),
        tool: attr('tool', 'Tool', 'id', 'The tool that produced it.'),
        depth: attr(
          'tool',
          'Hops',
          'number',
          "Tool calls between the user's turn and this text: 1 for a direct call, more through another agent.",
        ),
      }),
      error: attr('error', 'Detail', 'content', "The guardrail's internal reason."),
    },
  },
  'theorem.attempt.retry': {
    label: 'Retry',
    doc: 'The turn ran its model calls again.',
    attributes: {
      attempt: attr('agent', 'Attempt', 'number', 'The attempt that starts.'),
      reason: attr('agent', 'Reason', 'text', 'Why it retried.', RETRY_REASONS),
    },
  },
  'theorem.compaction': {
    label: 'Compaction',
    doc: 'THEOREM decided whether to summarize earlier messages.',
    attributes: {
      timing: attr('agent', 'Timing', 'text', 'When compaction runs.', COMPACTION_TIMING_OPTIONS),
      meter: attr(
        'agent',
        'Counts',
        'text',
        'What the threshold counts.',
        COMPACTION_METER_OPTIONS,
      ),
      budget: attr('usage', 'Budget', 'tokens', 'The token budget the threshold is a share of.'),
      threshold: attr('usage', 'Threshold', 'number', 'The share of the budget that triggers it.'),
      trigger: attr('agent', 'Trigger', 'text', 'custom when the host decides instead.'),
      tokens_before: attr('usage', 'Tokens counted', 'tokens', 'What the meter read.'),
      unknown_media: attr(
        'usage',
        'Uncounted media',
        'number',
        'Media items the count could not cover.',
      ),
      needed: attr('agent', 'Needed', 'boolean', 'The count crossed the threshold.'),
      compacted: attr('agent', 'Compacted', 'boolean', 'Earlier messages were summarized.'),
      messages_before: attr('messages', 'Messages before', 'number', 'History length before.'),
      messages_after: attr('messages', 'Messages after', 'number', 'History length after.'),
      summary: attr('messages', 'Summary', 'content', 'The summary that replaced them.'),
    },
  },
  exception: {
    label: 'Exception',
    doc: 'Something was thrown, or the provider reported an error.',
    attributes: {},
  },
  'theorem.upstream.row': {
    label: 'Provider data',
    doc: 'One row of data from the provider, at the time it arrived.',
    attributes: {
      row: attr('response', 'Row', 'json', 'The row, scrubbed, with media and known text by hash.'),
    },
  },
  'theorem.wire.request': {
    label: 'Request body',
    doc: 'The body sent to the provider.',
    attributes: {
      body: attr(
        'request',
        'Body',
        'json',
        'The body, scrubbed, with media and known text by hash.',
      ),
      body_kind: attr('request', 'Body type', 'text', 'What the body was, when it was not JSON.'),
    },
  },
  'theorem.grounding': {
    label: 'Grounding',
    doc: 'Sources and citations the answer drew on.',
    attributes: {
      provider: attr('response', 'Provider', 'id', 'Who supplied the evidence.'),
      sources: attr('response', 'Sources', 'json', 'The sources.'),
      citations: attr('response', 'Citations', 'json', 'Where the answer cites them.'),
      annotations: attr('response', 'Annotations', 'json', 'Citation annotations on the text.'),
      search_html: attr('response', 'Search suggestions', 'content', "Google's search widget."),
      raw: attr('response', 'Raw', 'json', "The provider's raw grounding payload."),
    },
  },
  'theorem.gate': {
    label: 'Approval needed',
    doc: 'The call stopped until the user answers.',
    attributes: {
      kind: attr('tool', 'Needs', 'text', 'What the user must give.', GATE_KINDS),
      permission: attr(
        'tool',
        'Permission',
        'text',
        "The tool's permission tier.",
        TOOL_PERMISSION_OPTIONS,
      ),
      summary: attr('tool', 'Summary', 'content', 'What the user is asked to approve.'),
      auth: fields(
        'tool',
        'Sign-in',
        'The credential asked for. The challenge state is a secret and is never recorded.',
        {
          slot: attr('tool', 'Credential', 'id', 'The credential slot the tool reads.'),
          type: attr('tool', 'Type', 'text', 'The kind of credential.'),
          issuer: attr('tool', 'Issuer', 'id', 'Who issues it.'),
          resource: attr('tool', 'Resource', 'id', 'What it grants access to.'),
          required_scopes: attr('tool', 'Scopes', 'list', 'The scopes it must carry.'),
        },
      ),
    },
  },
  'theorem.tool.cancel': {
    label: 'Tool call cancelled',
    doc: 'The provider cancelled a tool call it had made.',
    attributes: {},
  },
  'theorem.session': {
    label: 'Session',
    doc: 'Something happened to the Live session.',
    attributes: {
      kind: attr('agent', 'What happened', 'text', 'The session fact recorded.', SESSION_KINDS),
      time_left_ms: attr(
        'agent',
        'Time left',
        'milliseconds',
        'How long the provider said the session had left.',
      ),
      closed_after_ms: attr(
        'agent',
        'Closed after',
        'milliseconds',
        'How long after the warning the socket closed.',
      ),
      cause: attr('agent', 'Cause', 'text', 'go_away when the provider had warned it would close.'),
      code: attr('http', 'Close code', 'number', 'The WebSocket close code.'),
      reason: attr('http', 'Close reason', 'text', 'The WebSocket close reason.'),
      initiator: attr('agent', 'Closed by', 'text', 'Who closed the socket.', CLOSE_INITIATORS),
      activity: attr('agent', 'Activity', 'text', "The provider's voice activity signal."),
      audio_offset: attr('agent', 'Audio offset', 'text', 'Where in the audio it was heard.'),
      resumable: attr('agent', 'Resumable', 'boolean', 'The session can be resumed now.'),
      handle_issued: attr(
        'agent',
        'Handle issued',
        'boolean',
        'The provider sent a resumption handle. The handle is a credential and is never recorded.',
      ),
      key_slot: attr('request', 'From key', 'text', 'The key slot refused.', KEY_SLOT_OPTIONS),
      to_key_slot: attr(
        'request',
        'To key',
        'text',
        'The key slot it reopened on.',
        KEY_SLOT_OPTIONS,
      ),
      error: attr('error', 'Detail', 'text', "The provider's refusal."),
    },
  },
};

/** What an event records; `undefined` for an event THEOREM does not write. */
function traceEventMeta(name: string): TraceEventMeta | undefined {
  return TRACE_EVENTS[name];
}

/** What one of an event's attributes means: the event's own entry, else the span attribute of that key. */
function traceEventAttributeMeta(event: string, key: string): TraceAttributeMeta | undefined {
  return TRACE_EVENTS[event]?.attributes[key] ?? traceAttributeMeta(key);
}

// ── spans ───────────────────────────────────────────

const SPANS = {
  turn: { label: 'Turn', doc: 'One exchange: the model calls and tool calls it took to answer.' },
  session: { label: 'Live session', doc: 'A Live session, from setup to close.' },
  call: { label: 'Model call', doc: 'One request to a model and its answer.' },
  response: { label: 'Live response', doc: 'One spoken response in a Live session.' },
  tool: { label: 'Tool call', doc: 'One tool call THEOREM ran, from its hooks to settlement.' },
  http: { label: 'HTTP try', doc: 'One HTTP attempt of a model call.' },
  cutout: { label: 'Cutout', doc: 'A side effect the host recorded after the turn.' },
  host: { label: 'Host span', doc: 'A step the host recorded itself.' },
} satisfies Record<string, TraceOptionMeta>;

function stringAttribute(span: TraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function withSubject(meta: TraceOptionMeta, subject: string | undefined): TraceSpanMeta {
  return subject ? { ...meta, subject } : { ...meta };
}

/** What a span is, from what it recorded, and what it acted on. */
function traceSpanMeta(span: TraceSpan): TraceSpanMeta {
  switch (stringAttribute(span, 'gen_ai.operation.name')) {
    case 'invoke_agent':
      return withSubject(
        span.events.some((event) => event.name === 'theorem.session') ? SPANS.session : SPANS.turn,
        stringAttribute(span, 'gen_ai.agent.name'),
      );
    case 'chat':
    case 'generate_content':
      return withSubject(
        'theorem.request.live' in span.attributes ? SPANS.response : SPANS.call,
        stringAttribute(span, 'gen_ai.request.model'),
      );
    case 'execute_tool':
      return withSubject(SPANS.tool, stringAttribute(span, 'gen_ai.tool.name'));
    default:
      break;
  }
  if ('http.request.method' in span.attributes) {
    return withSubject(SPANS.http, stringAttribute(span, 'url.path'));
  }
  if (span.name === 'cutout') return withSubject(SPANS.cutout, stringAttribute(span, 'url.path'));
  return withSubject(SPANS.host, span.name);
}

export type {
  TraceAttributeGroup,
  TraceAttributeMeta,
  TraceEventMeta,
  TraceOptionMeta,
  TraceSpanMeta,
  TraceValueFormat,
};
export {
  TRACE_ATTRIBUTE_GROUPS,
  TRACE_FIELDS,
  TRACE_STATUS,
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
  traceSpanMeta,
};
