// invariant: A key with no entry is still a real attribute: viewers show it under its raw name.

import type { GuardrailRule } from '../guardrails/rules.ts';
import type { ErrorKind } from '../guardrails/theorem-error.ts';
import type {
  GuardrailAction,
  GuardrailStage,
  Severity,
  ToolOrigin,
  TrustLevel,
} from '../guardrails/types.ts';
import type { GuardrailCheck } from '../kernel/engine/turn-trace.ts';
import type {
  CompactionMeter,
  CompactionOutcome,
  CompactionTiming,
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
  | 'text'
  /** An identifier: shown as is, in monospace. */
  | 'id'
  | 'number'
  | 'tokens'
  | 'seconds'
  | 'milliseconds'
  | 'usd'
  | 'boolean'
  /** A list of strings. */
  | 'list'
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

/** The groups the attribute catalog sorts attributes into. */
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
  | 'part'
  | 'decision'
  | 'evaluation';

/** A label and description for one option in a catalog. */
interface TraceOptionMeta {
  label: string;
  doc: string;
}

/** What the catalog says about a span attribute: its label, description and format. */
interface TraceAttributeMeta {
  label: string;
  doc: string;
  format: TraceValueFormat;
  group: TraceAttributeGroup;
  options?: Readonly<Record<string, TraceOptionMeta>>;
  /** The options name the common values only: another value is real and shows as is. */
  open?: true;
  /** For an `object`: what its keys mean (for a list of objects, each item's keys). */
  fields?: Readonly<Record<string, TraceAttributeMeta>>;
}

/** What the catalog says about a span event: its label, description and keys. */
interface TraceEventMeta {
  label: string;
  doc: string;
  /** Keys this event carries. A key missing here reads from the span attribute catalog. */
  attributes: Readonly<Record<string, TraceAttributeMeta>>;
}

/** The kinds of span THEOREM writes, plus `host` for a span the host recorded itself. */
type TraceSpanType =
  | 'turn'
  | 'session'
  | 'call'
  | 'response'
  | 'tool'
  | 'http'
  | 'cutout'
  | 'decision'
  | 'evaluation'
  | 'host';

/** `subject` is the thing the span acted on (the model, tool or agent), when it names one. */
interface TraceSpanMeta {
  type: TraceSpanType;
  label: string;
  doc: string;
  subject?: string;
}

/** Labels and descriptions for each attribute group. */
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
  decision: {
    label: 'Decision',
    doc: 'The state a decision read, the questions it answered, and its answers.',
  },
  evaluation: { label: 'Evaluation', doc: 'How an eval graded this trace, and by which suite.' },
};

/** Labels and descriptions for each span status. */
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
  span: { label: 'Span', doc: 'One timed step of the trace.' },
  type: { label: 'Type', doc: 'What the span is: a turn, a model call, a tool call, an HTTP try.' },
  children: {
    label: 'Spans',
    doc: 'The spans inside this one, in start order: model calls, tool calls, HTTP tries.',
  },
  traceId: { label: 'Trace ID', doc: 'Shared by every span of one trace.' },
  spanId: { label: 'Span ID', doc: "This span's id." },
  status: { label: 'Status', doc: 'How the span ended.' },
  start: { label: 'Started', doc: 'When the span started.' },
  duration: { label: 'Duration', doc: 'From start to end, on the clock the record names.' },
  events: { label: 'Events', doc: 'What happened during the span, in order.' },
  links: { label: 'Links', doc: 'Earlier traces this span follows.' },
} satisfies Record<string, TraceOptionMeta>;

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

/** `error.type`: an error kind, or the failing stop. An HTTP status or exception shows as is. */
const ERROR_TYPE_OPTIONS: Readonly<Record<string, TraceOptionMeta>> = {
  ...ERROR_KIND_OPTIONS,
  provider_error: STOP_KINDS.provider_error,
  stream_incomplete: STOP_KINDS.stream_incomplete,
  grader_error: { label: 'Grader failed', doc: 'The grader threw instead of returning a result.' },
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

const LINK_KINDS: Readonly<Record<'resume' | 'continue' | 'retry' | 'trial', TraceOptionMeta>> = {
  resume: { label: 'Resumes', doc: 'Picks up a call that stopped for approval.' },
  continue: { label: 'Continues', doc: 'Continues an answer that stopped early.' },
  retry: { label: 'Retries', doc: 'Runs a failed turn again.' },
  trial: { label: 'Trial', doc: 'A graded trial of this eval run.' },
};

const EVALUATION_SOURCES: Readonly<Record<'code' | 'model', TraceOptionMeta>> = {
  code: { label: 'Code', doc: 'A deterministic check over the trace.' },
  model: { label: 'Model', doc: 'A judge profile read the transcript.' },
};

const PASS_RULES: Readonly<Record<'all' | 'any' | 'at_least', TraceOptionMeta>> = {
  all: { label: 'Every trial', doc: 'Passes only when every trial passed (pass^k).' },
  any: { label: 'Any trial', doc: 'Passes when at least one trial passed (pass@k).' },
  at_least: {
    label: 'At least n',
    doc: 'Passes when at least the stated number of trials passed.',
  },
};

const EVAL_STOPS: Readonly<Record<'budget', TraceOptionMeta>> = {
  budget: { label: 'Cost ceiling', doc: 'The summed cost crossed the ceiling the host set.' },
};

const CASE_KINDS: Readonly<Record<'capability' | 'regression', TraceOptionMeta>> = {
  capability: { label: 'Capability', doc: 'Can the agent do this at all?' },
  regression: { label: 'Regression', doc: 'Does the agent still do this?' },
};

const OPERATIONS: Readonly<
  Record<'invoke_agent' | 'chat' | 'generate_content' | 'execute_tool' | 'decide', TraceOptionMeta>
> = {
  invoke_agent: { label: 'Run agent', doc: 'One turn of an agent, or one Live session.' },
  chat: { label: 'Chat', doc: 'A model call over a chat-completions API.' },
  generate_content: { label: 'Generate content', doc: 'A model call over a Gemini API.' },
  execute_tool: { label: 'Run tool', doc: 'A tool call THEOREM ran.' },
  decide: {
    label: 'Decide',
    doc: 'One model decision: typed answers to questions over JSON state.',
  },
};

const OUTPUT_TYPES: Readonly<Record<'text' | 'json' | 'image' | 'speech', TraceOptionMeta>> = {
  text: { label: 'Text', doc: 'The model answers in text.' },
  json: { label: 'JSON', doc: 'The model answers with structured JSON.' },
  image: { label: 'Image', doc: 'The model answers with an image.' },
  speech: { label: 'Speech', doc: 'The model answers in audio.' },
};

const PROVIDERS: Readonly<Record<'gcp.gemini' | 'openrouter' | 'typesafe', TraceOptionMeta>> = {
  'gcp.gemini': { label: 'Google Gemini', doc: "Google's Gemini API." },
  openrouter: { label: 'OpenRouter', doc: 'The OpenRouter gateway.' },
  typesafe: { label: 'TypeSafe', doc: "TypeSafe's native decision API." },
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
  thought: { label: 'Thinking', doc: "The model's thoughts as they streamed." },
  network: { label: 'Network', doc: 'A URL the agent was about to reach.' },
  live_inbound: { label: 'Live inbound', doc: 'What arrived from a Live session.' },
  live_outbound: { label: 'Live outbound', doc: 'What was sent into a Live session.' },
  trace: { label: 'Trace', doc: 'Text being written to the trace.' },
};

/**
 * What each of Theorem's own guardrail rules caught. Keyed by every
 * {@link GuardrailRule}, so a new rule is described here before it compiles.
 * A host's own egress rules have no entry and show as their id.
 */
const GUARDRAIL_RULE_OPTIONS: Readonly<Record<GuardrailRule, TraceOptionMeta>> = {
  'detect.ids': {
    label: 'IDs',
    doc: 'A US SSN, ITIN or EIN number. The decision names the boundary it was crossing and what was done with it.',
  },
  'detect.financial': {
    label: 'Financial',
    doc: 'An IBAN or card number. The decision names the boundary it was crossing and what was done with it.',
  },
  'detect.network': {
    label: 'Network',
    doc: 'An IPv4 or IPv6 address. The decision names the boundary it was crossing and what was done with it.',
  },
  'detect.credentials': {
    label: 'Credentials',
    doc: 'An API key, token, password assignment or private key. The decision names the boundary it was crossing and what was done with it.',
  },
  'detect.injection': {
    label: 'Injection',
    doc: 'Text that tries to override the agent\'s instructions, such as "ignore previous instructions". The decision names the boundary it was crossing and what was done with it.',
  },
  'egress.canary-leak': {
    label: 'Instructions leaked',
    doc: "The reply contained the turn's canary, a secret marker planted in the instructions, so the model was repeating them.",
  },
  'egress.prompt-echo': {
    label: 'Instructions repeated',
    doc: 'The reply repeated 12 or more words in a row of the instructions.',
  },
  'egress.provider-tool-leak': {
    label: 'Instructions sent to a provider tool',
    doc: "A provider's built-in tool, such as search, was sent the canary or the instructions. It ran before Theorem saw it, so the data had already left.",
  },
  'egress.image-exfil': {
    label: 'Image from an unknown address',
    doc: 'The reply showed an image from an address the model was not given, on a host the profile does not allow. Loading it could send data out.',
  },
  'egress.link-exfil': {
    label: 'Link to an unknown address',
    doc: 'The reply linked an address the model was not given, on a host the profile does not allow.',
  },
  'egress.system-boundary': {
    label: 'Internal markers in reply',
    doc: 'The reply contained the markers Theorem uses to fence user data or name the canary.',
  },
  'egress.unscannable': {
    label: 'Reply could not be checked',
    doc: 'Structured output could not be turned into text to check, so it was treated as unsafe.',
  },
  'egress.enforcer-error': {
    label: 'Output check failed',
    doc: "The host's output check threw or returned no clear verdict, so the reply was treated as blocked.",
  },
  'egress.blocked': {
    label: 'Stopped while streaming',
    doc: "The host's output check stopped the reply mid-stream without naming a rule.",
  },
  'tool_result.names-callable-tool': {
    label: 'Named a callable tool',
    doc: 'Remote tool content named a tool the model can call, a common way to steer its next step.',
  },
  'tool_result.imperative': {
    label: 'Gave the agent an order',
    doc: 'Remote tool content addressed the agent with an instruction, such as "you must now…" or "next steps:".',
  },
  'tool_result.authority-claim': {
    label: 'Claimed authority',
    doc: 'Remote tool content claimed to speak for the user, the system or an admin, such as "the user has already approved".',
  },
  'tool_result.override': {
    label: 'Told the agent to drop its instructions',
    doc: 'Remote tool content told the agent to set its instructions aside, such as "ignore your instructions" or "disregard the rules above".',
  },
  'tool_call.tainted-turn': {
    label: 'Change after remote content',
    doc: 'A tool that writes or deletes was called after the turn read remote content, which could have steered it.',
  },
  'tool_call.steered-turn': {
    label: 'Change after a remote instruction',
    doc: 'A tool that writes or deletes was called after the turn read remote content that also looked like instructions to the agent.',
  },
  'network.blocked': {
    label: 'Address blocked',
    doc: 'A tool tried to reach a private, local or disallowed address. The request was never made.',
  },
};

const GUARDRAIL_CHECK_OPTIONS: Readonly<Record<GuardrailCheck, TraceOptionMeta>> = {
  input: { label: 'Input check', doc: 'Checked what the user sent before the model read it.' },
  egress: { label: 'Output check', doc: 'Checked the whole answer before it was released.' },
  tool_arguments: { label: 'Argument check', doc: 'Checked what the model sent to a tool.' },
  taint: {
    label: 'Remote-content gate',
    doc: 'Checked whether a tool that writes or deletes was called after the turn read remote content.',
  },
  tool_result: {
    label: 'Result check',
    doc: 'Checked what a tool returned before the model read it.',
  },
  tool_failure: {
    label: 'Error check',
    doc: "Checked a tool's error message before the model read it.",
  },
  network: { label: 'Address check', doc: 'Checked the address a tool was about to reach.' },
  network_request: {
    label: 'Lookup and redirect check',
    doc: "Checked, during a tool's request, where its address resolved and every redirect it followed; includes the lookup when the host resolves names.",
  },
  output_stream: {
    label: 'Streaming check',
    doc: 'Checked the answer piece by piece as it streamed, before the host saw each piece.',
  },
  stream_canary: {
    label: 'Streamed leak check',
    doc: "Checked each streamed tool call and other non-text output for the system prompt's canary.",
  },
  live_input: { label: 'Live input check', doc: 'Checked text the host sent into a live session.' },
  live_output: {
    label: 'Live output check',
    doc: 'Checked what the model said in a live session, batch by batch, before the host heard it.',
  },
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

const COMPACTION_OUTCOME_OPTIONS: Readonly<Record<CompactionOutcome, TraceOptionMeta>> = {
  compacted: { label: 'Compacted', doc: 'A summary replaced the earlier messages.' },
  deferred: {
    label: 'Kept whole',
    doc: 'The compactor failed and the history still fits, so it was kept and compaction runs again next turn.',
  },
  dropped: {
    label: 'Dropped',
    doc: 'The compactor failed and the history no longer fits, so the earlier messages were dropped.',
  },
};

/** `theorem.session` kinds: provider session signals (a finished response is its own record). */
const SESSION_KINDS: Readonly<
  Record<
    | Exclude<SessionEventKind, 'turn_complete'>
    | 'voice_activity'
    | 'session_resumption'
    | 'setup_complete'
    | 'key_fallback'
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
  key_fallback: {
    label: 'Switched to fallback key',
    doc: "The key was refused for quota at setup; the session reopened on the profile's fallback key.",
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

function attr(
  group: TraceAttributeGroup,
  label: string,
  format: TraceValueFormat,
  doc: string,
  options?: Readonly<Record<string, TraceOptionMeta>>,
): TraceAttributeMeta {
  return options ? { label, doc, format, group, options } : { label, doc, format, group };
}

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
  'theorem.turn.time_to_first_text': attr(
    'agent',
    'Time to first visible text',
    'seconds',
    'From the start of the turn to the first reply text the host received, after every guardrail and holdback.',
  ),
  'theorem.guardrail.stream_ms': attr(
    'agent',
    'Stream guardrail time',
    'milliseconds',
    "Time every check on this call's streamed output took, together; each check's own time is on its `theorem.guardrail` event.",
  ),
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
    'The vault key slot that finally answered, by the name the profile gave it.',
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
    resolution: attr(
      'request',
      'Resolution',
      'text',
      'How detailed the image is, such as 1K, 2K or 4K.',
    ),
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
    ),
    transcription: fields(
      'request',
      'Transcription',
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
    'From the start of the successful HTTP try, or of a Live response, to its first chunk; a buffered body is its one chunk.',
  ),
  'theorem.response.time_to_first_text': attr(
    'response',
    'Time to first text',
    'seconds',
    'From the start of the call to its first reply text, before guardrails; reasoning and tool calls do not count.',
  ),

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
    "As the provider reported it, or priced from Jev's fixed price for a decision. Absent when no call reported a cost.",
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
  'exception.stacktrace': attr('error', 'Stack', 'content', 'Where it was thrown, scrubbed.'),

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

  'theorem.decision.contract': attr(
    'decision',
    'Contract',
    'id',
    "The host's decision contract the profile names.",
  ),
  'theorem.decision.state': attr('decision', 'State', 'json', 'The JSON state the decision read.'),
  'theorem.decision.questions': attr(
    'decision',
    'Questions',
    'json',
    'Each question by id: its kind, instructions and criteria.',
  ),
  'theorem.decision.answers': attr(
    'decision',
    'Answers',
    'json',
    'Each answer by question id: the choice or score, its confidence and probabilities.',
  ),

  'gen_ai.evaluation.name': attr(
    'evaluation',
    'Grader',
    'id',
    'The grader that produced this result.',
  ),
  'gen_ai.evaluation.score.value': attr(
    'evaluation',
    'Score',
    'number',
    'The score, 0–1 unless the grader says otherwise.',
  ),
  'gen_ai.evaluation.score.label': attr(
    'evaluation',
    'Label',
    'text',
    "The grader's label for this trial, one of the labels it declares.",
  ),
  'gen_ai.evaluation.explanation': attr(
    'evaluation',
    'Explanation',
    'content',
    "Why, in the grader's words.",
  ),
  'theorem.evaluation.source': attr(
    'evaluation',
    'Graded by',
    'text',
    'Who produced this result.',
    EVALUATION_SOURCES,
  ),
  'theorem.evaluation.suite': attr('evaluation', 'Suite', 'id', 'The eval suite that ran.'),
  'theorem.evaluation.case': attr(
    'evaluation',
    'Case',
    'id',
    'The case this trial ran. Absent when a production trace was graded without one.',
  ),
  'theorem.evaluation.trial': attr(
    'evaluation',
    'Trial',
    'number',
    'Which trial of the case this is, from 0.',
  ),
  'theorem.evaluation.grader.version': attr(
    'evaluation',
    'Grader version',
    'id',
    "The sha256 of the grader's rubric or code identity, so a reader can tell which rubric scored this.",
  ),
  'theorem.evaluation.passed': attr(
    'evaluation',
    'Passed',
    'boolean',
    "The grader's yes or no. Absent when the result informs but does not decide.",
  ),
  'theorem.eval.repeat': attr(
    'evaluation',
    'Trials per case',
    'number',
    'How many times each case ran.',
  ),
  'theorem.eval.pass_rule': attr(
    'evaluation',
    'Pass rule',
    'text',
    'How the trials of a case become its verdict.',
    PASS_RULES,
  ),
  'theorem.eval.pass_at_least': attr(
    'evaluation',
    'Trials needed',
    'number',
    'Trials that must pass under the at-least rule.',
  ),
  'theorem.eval.caseless': attr(
    'evaluation',
    'Caseless',
    'boolean',
    'Production traces were graded with no cases: only graders that need no expectation ran.',
  ),
  'theorem.eval.stopped': attr(
    'evaluation',
    'Stopped early',
    'text',
    'Why the run stopped before its end.',
    EVAL_STOPS,
  ),
  'vcs.ref.head.revision': attr('evaluation', 'Commit', 'id', 'The commit under test.'),
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

const HITS = fields('error', 'Hits', 'Each rule that matched.', {
  rule: {
    ...attr(
      'error',
      'Rule',
      'id',
      "The rule that matched: one of Theorem's own, or a host policy's, which names itself.",
      GUARDRAIL_RULE_OPTIONS,
    ),
    open: true,
  },
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
  label: attr('error', 'Rule name', 'text', "A host rule's own name for what it catches."),
  doc: attr('error', 'Why it matters', 'text', "A host rule's own account of why a match matters."),
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
    doc: 'A guardrail checked some text: what it did, or `allow` for a timed check that let the text through.',
    attributes: {
      check: attr('agent', 'Check', 'id', 'Which timed check ran.', GUARDRAIL_CHECK_OPTIONS),
      duration_ms: attr(
        'agent',
        'Check time',
        'milliseconds',
        'Time the check took; a check on streamed output, its total over the call.',
      ),
      runs: attr(
        'agent',
        'Runs',
        'number',
        'How many times a check on streamed output ran on the call.',
      ),
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
      outcome: attr(
        'agent',
        'Outcome',
        'text',
        'What happened to the earlier messages.',
        COMPACTION_OUTCOME_OPTIONS,
      ),
      messages_before: attr('messages', 'Messages before', 'number', 'History length before.'),
      messages_after: attr('messages', 'Messages after', 'number', 'History length after.'),
      dropped_media: attr(
        'messages',
        'Media left out',
        'number',
        'Media the compactor does not take, left out of what it read.',
      ),
      failure_stop: attr(
        'agent',
        'Compactor stop',
        'text',
        'How the failed compactor stopped.',
        STOP_KINDS,
      ),
      failure_error: attr(
        'agent',
        'Compactor error',
        'text',
        'The error the compactor failed with.',
        ERROR_KIND_OPTIONS,
      ),
      failure_empty: attr(
        'agent',
        'Empty summary',
        'boolean',
        'The compactor replied with nothing.',
      ),
      failure_unreadable: attr(
        'agent',
        'Nothing to read',
        'boolean',
        'Everything to compact was media the compactor does not take, so it did not run.',
      ),
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
          service: attr('tool', 'Service', 'text', 'The service the person signs in to.'),
          issuer: attr('tool', 'Issuer', 'id', 'Who issues it.'),
          resource: attr('tool', 'Resource', 'id', 'What it grants access to.'),
          required_scopes: attr('tool', 'Scopes', 'list', 'The scopes it must carry.'),
        },
      ),
    },
  },
  'theorem.auth.scope_refused': {
    label: 'Access refused',
    doc: 'The service asked for access outside the scopes the tool declares, so no sign-in was offered.',
    attributes: {
      slot: attr('tool', 'Credential', 'id', 'The credential slot the tool reads.'),
      requested: attr('tool', 'Asked for', 'list', 'The scopes the service asked for.'),
      declared: attr('tool', 'Declared', 'list', 'The scopes the tool declares.'),
    },
  },
  'theorem.tool.warning': {
    label: 'Tool warning',
    doc: 'Something the tool flagged while it ran; the call went on.',
    attributes: {
      code: attr('tool', 'Code', 'id', 'The warning, by name.'),
      message: attr('tool', 'Message', 'content', 'What the tool said.'),
      severity: attr('tool', 'Severity', 'text', 'How serious the tool says it is.'),
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
      key_slot: attr('request', 'From key', 'text', 'The key slot refused.'),
      to_key_slot: attr(
        'request',
        'To key',
        'text',
        "The profile's fallback key slot it reopened on.",
      ),
      error: attr('error', 'Detail', 'text', "The provider's refusal."),
    },
  },
  'gen_ai.evaluation.result': {
    label: 'Eval result',
    doc: "One grader's reading of this trace. Its keys are span attributes of the evaluation group.",
    attributes: {},
  },
  'theorem.eval.verdict': {
    label: 'Verdict',
    doc: "One case's pass or fail after its trials, by the suite's pass rule. Every case is here, zeros included.",
    attributes: {
      case: attr('evaluation', 'Case', 'id', 'The case judged.'),
      kind: attr('evaluation', 'Kind', 'text', "Anthropic's split of cases.", CASE_KINDS),
      difficulty: attr(
        'evaluation',
        'Difficulty',
        'number',
        'The case’s 1–5 difficulty, when the suite set one.',
      ),
      passed: attr('evaluation', 'Passed', 'boolean', 'The pass rule was met.'),
      trials: attr('evaluation', 'Trials', 'number', 'Trials run.'),
      trials_passed: attr(
        'evaluation',
        'Passed trials',
        'number',
        'Trials every deciding grader passed.',
      ),
      trials_errored: attr(
        'evaluation',
        'Errored trials',
        'number',
        'Trials a grader could not score; they count as failed.',
      ),
      trials_ungraded: attr('evaluation', 'Ungraded trials', 'number', 'Trials no grader decided.'),
    },
  },
};

/** What an event records; `undefined` for an event THEOREM does not write. */
function traceEventMeta(name: string): TraceEventMeta | undefined {
  return TRACE_EVENTS[name];
}

/** The event's own entry, else the span attribute of that key. */
function traceEventAttributeMeta(event: string, key: string): TraceAttributeMeta | undefined {
  return TRACE_EVENTS[event]?.attributes[key] ?? traceAttributeMeta(key);
}

/** Labels and descriptions for each span type. */
const TRACE_SPAN_TYPES: Readonly<Record<TraceSpanType, TraceOptionMeta>> = {
  turn: { label: 'Turn', doc: 'One exchange: the model calls and tool calls it took to answer.' },
  session: { label: 'Live session', doc: 'A Live session, from setup to close.' },
  call: { label: 'Model call', doc: 'One request to a model and its answer.' },
  response: { label: 'Live response', doc: 'One spoken response in a Live session.' },
  tool: { label: 'Tool call', doc: 'One tool call THEOREM ran, from its hooks to settlement.' },
  http: { label: 'HTTP try', doc: 'One HTTP attempt of a model call.' },
  cutout: { label: 'Cutout', doc: 'A side effect the host recorded after the turn.' },
  decision: { label: 'Decision', doc: 'One typed decision over JSON state.' },
  evaluation: { label: 'Evaluation', doc: 'An eval graded this trace, or a suite ran.' },
  host: { label: 'Host span', doc: 'A step the host recorded itself.' },
};

function stringAttribute(span: TraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function withSubject(type: TraceSpanType, subject: string | undefined): TraceSpanMeta {
  const meta = { type, ...TRACE_SPAN_TYPES[type] };
  return subject ? { ...meta, subject } : meta;
}

/** The label, subject and description to show for a span. */
function traceSpanMeta(span: TraceSpan): TraceSpanMeta {
  switch (stringAttribute(span, 'gen_ai.operation.name')) {
    case 'invoke_agent':
      return withSubject(
        span.events.some((event) => event.name === 'theorem.session') ? 'session' : 'turn',
        stringAttribute(span, 'gen_ai.agent.name'),
      );
    case 'chat':
    case 'generate_content':
      return withSubject(
        'theorem.request.live' in span.attributes ? 'response' : 'call',
        stringAttribute(span, 'gen_ai.request.model'),
      );
    case 'execute_tool':
      return withSubject('tool', stringAttribute(span, 'gen_ai.tool.name'));
    case 'decide':
      return withSubject('decision', stringAttribute(span, 'gen_ai.agent.name'));
    default:
      break;
  }
  if ('http.request.method' in span.attributes) {
    return withSubject('http', stringAttribute(span, 'url.path'));
  }
  if (span.name === 'cutout') return withSubject('cutout', stringAttribute(span, 'url.path'));
  if (span.name === 'theorem.eval.trial' || span.name === 'theorem.eval.run') {
    return withSubject('evaluation', stringAttribute(span, 'theorem.evaluation.suite'));
  }
  return withSubject('host', span.name);
}

export type {
  TraceAttributeGroup,
  TraceAttributeMeta,
  TraceEventMeta,
  TraceOptionMeta,
  TraceSpanMeta,
  TraceSpanType,
  TraceValueFormat,
};
export {
  TRACE_ATTRIBUTE_GROUPS,
  TRACE_FIELDS,
  TRACE_SPAN_TYPES,
  TRACE_STATUS,
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
  traceSpanMeta,
};
