/** labels-exempt-file: authoring request-field and export meta — not runtime user or model copy (P2) */

import type { FieldMeta } from './schema.ts';
import type { TurnInput, TurnRequest } from './types.ts';

/** The catalog of the fields a `runTurn` request takes, keyed `runTurn.<field>`. */
export const REQUEST_FIELDS: Record<
  `runTurn.${keyof TurnRequest | `input.${keyof TurnInput}`}`,
  FieldMeta
> = {
  'runTurn.background': {
    type: 'ToolBackgroundService',
    doc: 'Host-issued service for tool calls that go on after their reply. It needs a coordinator with detach. Without it every tool runs inline.',
  },
  'runTurn.pageExecution': {
    type: 'PageToolExecution',
    doc: 'Host-issued browser dispatch with a claimed operation and correlated result.',
  },
  'runTurn.execution': {
    type: 'ToolExecutionCoordinator',
    doc: 'Host-owned atomic tool claims and outcomes. Never sent to providers.',
  },
  'runTurn.providerState': {
    type: 'ProviderCheckpoint',
    doc: 'Native provider state saved alongside portable history.',
  },
  'runTurn.profile': {
    type: 'string',
    doc: 'The id of the registered profile the turn runs.',
    required: true,
  },
  'runTurn.input': { type: 'TurnInput', doc: 'What the user sent for the turn.' },
  'runTurn.input.text': { type: 'string', doc: "The user's message." },
  'runTurn.input.options': {
    type: 'Record<string, string>',
    doc: "The value a person picked for each option in the profile's inputs.options; an option or a value the profile does not declare is refused.",
    unset: 'The person picked none',
  },
  'runTurn.input.context': {
    type: "Partial<Record<'client' | 'server', unknown>>",
    doc: "What the page (client) or the host (server) wants the model to know, as any JSON or text; a sender the profile's inputs.context does not list, or a package over its maxChars, is refused.",
    unset: 'No context',
  },
  'runTurn.input.lateResults': {
    type: 'ToolOperationOutcome[]',
    doc: 'Background tool calls that settled after their turn, as the host stored them. The model reads each as a tool result, and this reply counts it as a remote read when the call was remote. Pass each one once: the turn emits it as a late_results event, so a history built from events holds it.',
    unset: 'No late results',
  },
  'runTurn.input.attachments': {
    type: 'Array<TurnBlob | TurnMediaRef>',
    doc: "Files sent with the turn, as bytes or as a provider file reference; each must pass the profile's inputs.attachments.",
  },
  'runTurn.input.voice': {
    type: 'TurnBlob[]',
    doc: "Recorded speech sent with the turn; each must pass the profile's inputs.voice.",
  },
  'runTurn.input.history': {
    type: 'TurnHistoryMessage[]',
    doc: 'The earlier messages of the conversation, when the host keeps them.',
    unset: 'The turn starts a new conversation',
  },
  'runTurn.input.repair': {
    type: 'TurnRepairRequest',
    doc: 'A reply your host rejected and why, so that the model writes it again.',
  },
  'runTurn.input.historyTokens': {
    type: 'number',
    doc: "Your count of the history's tokens, used by compaction that meters history.",
    unset: "Theorem's own estimate",
  },
  'runTurn.input.inputTokens': {
    type: 'number',
    doc: "Your count of the whole prompt's tokens, used by compaction that meters input before the call.",
  },
  'runTurn.model': {
    type: 'string',
    doc: "The model id the turn picks from the profile's models; refused unless the profile sets allowModelSelect.",
    unset: "The profile's defaultModel",
  },
  'runTurn.effort': {
    type: 'string',
    doc: "The effort the turn picks from the model's efforts; refused unless the model sets allowEffortSelect.",
    unset: "The model's default effort",
  },
  'runTurn.builtInArgs': {
    type: 'Record<BuiltinToolId, JsonObject>',
    doc: "Args for the provider's own tools on the chosen model's builtInTools, by tool id; each is checked by the schema the provider declares for that tool.",
    unset: 'Each built-in runs with no args',
  },
  'runTurn.system': {
    type: 'SystemPrompt',
    doc: "An instruction for this request only, added to the profile's own.",
  },
  'runTurn.options': {
    type: 'Record<string, string>',
    doc: "The value the host's code sets for each option in the profile's identity.options but path; an option or a value the profile does not declare is refused.",
    unset: 'The code set none',
  },
  'runTurn.path': {
    type: 'string',
    doc: 'The channel the turn comes from; only tools whose paths name it, or *, are offered.',
    unset: 'Only tools on every path',
  },
  'runTurn.sessionPermissions': {
    type: 'string[]',
    doc: 'The tools the user has already approved for this session.',
  },
  'runTurn.credentials': {
    type: 'ToolCredentialSource',
    doc: 'Where an HTTP or MCP tool gets the credential for its auth slot.',
  },
  'runTurn.host': {
    type: 'unknown',
    doc: 'Your own context, handed to tool handlers as ctx.host; Theorem never reads or records it.',
  },
  'runTurn.signal': {
    type: 'AbortSignal',
    doc: 'Stops the turn when it aborts, and cancels the provider call where the provider can.',
  },
  'runTurn.sessionId': {
    type: 'string',
    doc: 'A session key that OpenRouter uses for routing and caching.',
  },
  'runTurn.projectId': {
    type: 'string',
    doc: 'Your project id, recorded on the trace.',
  },
  'runTurn.conversationId': {
    type: 'string',
    doc: 'Your conversation id, recorded on the trace.',
  },
  'runTurn.metadata': {
    type: 'Record<string, unknown>',
    doc: 'Your own values, kept on the trace; Theorem does not read them.',
  },
  'runTurn.traceparent': {
    type: 'string',
    doc: "The W3C traceparent of your span; the turn's trace joins it as a child.",
    unset: 'The turn starts a new trace',
  },
  'runTurn.links': {
    type: 'TurnTraceLink[]',
    doc: 'Earlier traces this turn follows: a resume, a continue, or a retry.',
  },
  'runTurn.continueFrom': {
    type: 'TurnContinueFrom',
    doc: 'Continues a turn that stopped in a way the profile lets a turn continue.',
  },
  'runTurn.continuation': {
    type: 'number',
    doc: 'Which continue attempt this is, from 1; checked against the maxContinues of the profile.',
  },
  'runTurn.promoted': {
    type: 'ToolId[]',
    doc: 'Tools this reply already had when an earlier run of it paused; the turn opens with them on its list.',
  },
  'runTurn.stepsTaken': {
    type: 'number',
    doc: 'Steps this reply already took when an earlier run of it paused; they count against maxSteps.',
  },
  'runTurn.speech': {
    type: 'TurnSpeech',
    doc: "This turn's voice, style, and speed; each one given replaces the profile's speech field of that name. Refused on a profile that is not speech.",
    unset: "The profile's speech settings",
  },
  'runTurn.resolveHost': {
    type: 'ResolveHost',
    doc: 'Resolves the host name of a remote tool before each request; a name that resolves to a private address is refused.',
  },
  'runTurn.fetch': {
    type: 'typeof fetch',
    doc: "Sends each request a remote tool makes, once that request's network checks pass. A page whose tools cannot reach a host directly sends them through its own server here.",
    unset: 'The global fetch',
  },
  'runTurn.onStage': {
    type: 'StageHandler',
    doc: 'Your function that sees each stage of a text turn and can answer with what the stage allows.',
  },
  'runTurn.onAgentCall': {
    type: 'AgentCallHook',
    doc: 'Runs before each agent tool call, to shape the request to the called agent or to refuse the call.',
    unset: 'The agent runs on what the model sent',
  },
  'runTurn.onEvent': {
    type: '(event: TurnEvent) => void | Promise<void>',
    doc: "Reads each of the turn's events as it leaves runTurn, before the caller gets it. A throw ends the turn with that error.",
  },
  'runTurn.answersHeldCall': {
    type: 'true',
    doc: "Set on the turn TurnWiring.prepare is given for a held call that goes on once answered: no model runs, and input is the paused turn's.",
  },
};

/** What the catalog records about one export: what it is and what it does. */
export type ApiExportMeta = { kind: 'function' | 'class'; doc: string };

/** The catalog of the exports a builder calls by name, keyed by that name. */
export const API_EXPORTS = {
  defineProfile: {
    kind: 'function',
    doc: 'Checks a profile and returns it; a field the profile type cannot take is a config error.',
  },
  registerProfile: {
    kind: 'function',
    doc: 'Stores a profile under its id, so that a request can name it.',
  },
  registerTool: {
    kind: 'function',
    doc: 'Stores a tool under its name, so that a profile can list it in tools.allow.',
  },
  registerStructured: {
    kind: 'function',
    doc: 'Stores a JSON Schema under an id, so that a profile can name it in outputs.structured.',
  },
  registerTraceDestination: {
    kind: 'function',
    doc: 'Stores a place to write traces under an id, so that a profile can name it in observability.',
  },
  defineProvider: {
    kind: 'function',
    doc: 'Validates a provider definition and supplies its typed model helper.',
  },
  registerProvider: {
    kind: 'function',
    doc: 'Registers a provider instance before profiles reference its ID.',
  },
  runTurn: {
    kind: 'function',
    doc: 'Runs one turn of a text, image, or speech profile and yields its events.',
  },
  runSession: {
    kind: 'function',
    doc: 'Runs a realtime voice or video session of a live profile.',
  },
  runDecision: {
    kind: 'function',
    doc: 'Asks a decision profile its questions about your JSON state and returns checked answers.',
  },
  invokeTool: {
    kind: 'function',
    doc: 'Runs one registered tool through a profile, with no model.',
  },
  runTool: {
    kind: 'function',
    doc: 'Runs one registered tool through a profile, with no model, and returns how the call settled.',
  },
  compactHistory: {
    kind: 'function',
    doc: 'Shortens a conversation history with the compaction the profile sets.',
  },
  takeSlot: {
    kind: 'function',
    doc: "Takes a client's turn slot on a profile; it answers ok, busy, quota, or not_configured.",
  },
  releaseSlot: {
    kind: 'function',
    doc: 'Frees the turn slot that takeSlot gave.',
  },
  overrideLabels: {
    kind: 'function',
    doc: "Replaces status lines for every profile in the process; a profile's own labels wins.",
  },
  resetLabels: {
    kind: 'function',
    doc: 'Removes every replacement that overrideLabels made.',
  },
  TheoremError: {
    kind: 'class',
    doc: 'The error Theorem throws; its kind tells your host which status and wording to use.',
  },
} as const satisfies Record<string, ApiExportMeta>;
