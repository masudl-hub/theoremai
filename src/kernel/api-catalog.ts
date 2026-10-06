/** lexicon-exempt-file: authoring request-field and export meta — not runtime user or model copy (P2) */

import type { FieldMeta } from './schema.ts';
import type { TurnInput, TurnRequest } from './types.ts';

/** The catalog of the fields a `runTurn` request takes, keyed by path like `PROFILE_FIELDS`. */
export const REQUEST_FIELDS: Record<keyof TurnRequest | `input.${keyof TurnInput}`, FieldMeta> = {
  profile: {
    type: 'string',
    doc: 'The id of the registered profile the turn runs.',
    required: true,
  },
  input: { type: 'TurnInput', doc: 'What the user sent for the turn.' },
  'input.text': { type: 'string', doc: "The user's message." },
  'input.role': {
    type: 'string',
    doc: 'Picks the instruction of that name from identity.systemByRole.',
    unset: 'The profile instruction',
  },
  'input.slots': {
    type: 'Record<string, string>',
    doc: 'The choice the turn makes for each slot the profile declares in inputs.slots; a slot or a value the profile does not declare is refused.',
  },
  'input.attachments': {
    type: 'Array<TurnBlob | TurnMediaRef>',
    doc: "Files sent with the turn, as bytes or as a provider file reference; each must pass the profile's inputs.attachments.",
  },
  'input.voice': {
    type: 'TurnBlob[]',
    doc: "Recorded speech sent with the turn; each must pass the profile's inputs.voice.",
  },
  'input.history': {
    type: 'TurnHistoryMessage[]',
    doc: 'The earlier messages of the conversation, when the host keeps them.',
    unset: 'The turn starts a new conversation',
  },
  'input.repair': {
    type: 'TurnRepairRequest',
    doc: 'A reply your host rejected and why, so that the model writes it again.',
  },
  'input.historyTokens': {
    type: 'number',
    doc: "Your count of the history's tokens, used by compaction that meters history.",
    unset: "Theorem's own estimate",
  },
  'input.inputTokens': {
    type: 'number',
    doc: "Your count of the whole prompt's tokens, used by compaction that meters input before the call.",
  },
  'input.sessionResumptionHandle': {
    type: 'string',
    doc: 'The handle a live session gave, to resume that session.',
  },
  model: {
    type: 'string',
    doc: "The model id the turn picks from the profile's models; refused unless the profile sets allowModelSelect.",
    unset: "The profile's defaultModel",
  },
  effort: {
    type: 'string',
    doc: "The effort the turn picks from the model's efforts; refused unless the model sets allowEffortSelect.",
    unset: "The model's default effort",
  },
  system: {
    type: 'SystemPrompt',
    doc: "An instruction for this request only, added to the profile's own.",
  },
  path: {
    type: 'string',
    doc: 'The channel the turn comes from; only tools whose paths name it, or *, are offered.',
    unset: 'Only tools on every path',
  },
  sessionPermissions: {
    type: 'string[]',
    doc: 'The tools the user has already approved for this session.',
  },
  credentials: {
    type: 'ToolCredentialSource',
    doc: 'Where an HTTP or MCP tool gets the credential for its auth slot.',
  },
  host: {
    type: 'unknown',
    doc: 'Your own context, handed to tool handlers as ctx.host; Theorem never reads or records it.',
  },
  signal: {
    type: 'AbortSignal',
    doc: 'Stops the turn when it aborts, and cancels the provider call where the provider can.',
  },
  previousInteractionId: {
    type: 'string',
    doc: 'The id of the earlier turn, for a provider that keeps the conversation itself.',
    unset: 'The host sends input.history',
  },
  store: {
    type: 'boolean',
    doc: 'Whether the provider keeps this turn for a later previousInteractionId.',
    unset: 'The model binding decides',
  },
  sessionId: {
    type: 'string',
    doc: 'A session key that OpenRouter uses for routing and caching.',
  },
  projectId: {
    type: 'string',
    doc: 'Your project id, recorded on the trace.',
  },
  conversationId: {
    type: 'string',
    doc: 'Your conversation id, recorded on the trace.',
  },
  metadata: {
    type: 'Record<string, unknown>',
    doc: 'Your own values, kept on the trace; Theorem does not read them.',
  },
  traceparent: {
    type: 'string',
    doc: "The W3C traceparent of your span; the turn's trace joins it as a child.",
    unset: 'The turn starts a new trace',
  },
  links: {
    type: 'TurnTraceLink[]',
    doc: 'Earlier traces this turn follows: a resume, a continue or a retry.',
  },
  continueFrom: {
    type: 'TurnContinueFrom',
    doc: 'Continues a turn that stopped in a way the profile lets a turn continue.',
  },
  continuation: {
    type: 'number',
    doc: 'Which continue attempt this is, from 1; checked against the maxContinues of the profile.',
  },
  googleMapsLocation: {
    type: '{ latitude: number; longitude: number }',
    doc: 'Where the Google Maps built-in tool looks first; ignored when the model has no googleMaps.',
  },
  compactionProvider: {
    type: 'ModelProvider',
    doc: "Runs compaction before the call when the turn's own provider cannot.",
  },
  sessionResumptionHandle: {
    type: 'string',
    doc: 'The handle a live session gave, to resume that session.',
  },
  resolveHost: {
    type: 'ResolveHost',
    doc: 'Resolves the host name of a remote tool before each request; a name that resolves to a private address is refused.',
  },
  onStage: {
    type: 'StageHandler',
    doc: 'Your function that sees each stage of a text turn and can answer with what the stage allows.',
  },
  onAgentCall: {
    type: 'AgentCallHook',
    doc: 'Runs before each agent tool call, to shape the request to the called agent or to refuse the call.',
    unset: "The agent runs on the model's text alone",
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
  createProvider: {
    kind: 'function',
    doc: 'Binds a profile to its model and to your key vault; runTurn takes the result.',
  },
  runTurn: {
    kind: 'function',
    doc: 'Runs one turn of a text, image or speech profile and yields its events.',
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
  compactHistory: {
    kind: 'function',
    doc: 'Shortens a conversation history with the compaction the profile sets.',
  },
  takeSlot: {
    kind: 'function',
    doc: "Takes a client's turn slot on a profile; it answers ok, busy, quota or not_configured.",
  },
  releaseSlot: {
    kind: 'function',
    doc: 'Frees the turn slot that takeSlot gave.',
  },
  overrideLexicon: {
    kind: 'function',
    doc: "Replaces status lines for every profile in the process; a profile's own lexicon wins.",
  },
  resetLexicon: {
    kind: 'function',
    doc: 'Removes every replacement that overrideLexicon made.',
  },
  TheoremError: {
    kind: 'class',
    doc: 'The error Theorem throws; its kind tells your host which status and wording to use.',
  },
} as const satisfies Record<string, ApiExportMeta>;
