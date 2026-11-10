/** labels-exempt-file: authoring request-field and export meta — not runtime user or model copy (P2) */

import { EXPORT_DOCS, FIELD_DOCS } from './field-docs.ts';
import type { FieldMeta } from './schema.ts';
import type { TurnInput, TurnRequest } from './types.ts';

/** A `runTurn` request field's catalog path. */
export type RequestPath = `runTurn.${keyof TurnRequest | `input.${keyof TurnInput}`}`;

/** Gives each row its doc: the JSDoc on its declaration, through `FIELD_DOCS`. */
function withFieldDocs<K extends string>(
  rows: Record<K, Omit<FieldMeta, 'doc'>>,
): Record<K, FieldMeta> {
  return Object.fromEntries(
    Object.entries<Omit<FieldMeta, 'doc'>>(rows).map(([path, { type, ...rest }]) => [
      path,
      { type, doc: FIELD_DOCS[path] ?? '', ...rest },
    ]),
  ) as Record<K, FieldMeta>;
}

/** The catalog of the fields a `runTurn` request takes, keyed `runTurn.<field>`. */
export const REQUEST_FIELDS: Record<RequestPath, FieldMeta> = withFieldDocs<RequestPath>({
  'runTurn.background': {
    type: 'ToolBackgroundService',
  },
  'runTurn.pageExecution': {
    type: 'PageToolExecution',
  },
  'runTurn.execution': {
    type: 'ToolExecutionCoordinator',
  },
  'runTurn.providerState': {
    type: 'ProviderCheckpoint',
  },
  'runTurn.profile': {
    type: 'string',
    required: true,
  },
  'runTurn.input': { type: 'TurnInput' },
  'runTurn.input.text': { type: 'string' },
  'runTurn.input.options': {
    type: 'Record<string, string>',
    unset: 'The person picked none',
  },
  'runTurn.input.context': {
    type: "Partial<Record<'client' | 'server', unknown>>",
    unset: 'No context',
  },
  'runTurn.input.lateResults': {
    type: 'ToolOperationOutcome[]',
    unset: 'No late results',
  },
  'runTurn.input.attachments': {
    type: 'Array<TurnBlob | TurnMediaRef>',
  },
  'runTurn.input.voice': {
    type: 'TurnBlob[]',
  },
  'runTurn.input.history': {
    type: 'TurnHistoryMessage[]',
    unset: 'The turn starts a new conversation',
  },
  'runTurn.input.repair': {
    type: 'TurnRepairRequest',
  },
  'runTurn.input.messageId': {
    type: 'string',
    unset: 'The fence carries no id',
  },
  'runTurn.input.historyTokens': {
    type: 'number',
    unset: "Theorem's own estimate",
  },
  'runTurn.input.inputTokens': {
    type: 'number',
  },
  'runTurn.model': {
    type: 'string',
    unset: "The profile's defaultModel",
  },
  'runTurn.effort': {
    type: 'string',
    unset: "The model's default effort",
  },
  'runTurn.builtInArgs': {
    type: 'Record<BuiltinToolId, JsonObject>',
    unset: 'Each built-in runs with no args',
  },
  'runTurn.system': {
    type: 'SystemPrompt',
  },
  'runTurn.options': {
    type: 'Record<string, string>',
    unset: 'The code set none',
  },
  'runTurn.path': {
    type: 'string',
    unset: 'Only tools on every path',
  },
  'runTurn.sessionPermissions': {
    type: 'string[]',
  },
  'runTurn.credentials': {
    type: 'ToolCredentialSource',
  },
  'runTurn.host': {
    type: 'unknown',
  },
  'runTurn.signal': {
    type: 'AbortSignal',
  },
  'runTurn.sessionId': {
    type: 'string',
  },
  'runTurn.projectId': {
    type: 'string',
  },
  'runTurn.conversationId': {
    type: 'string',
  },
  'runTurn.metadata': {
    type: 'Record<string, unknown>',
  },
  'runTurn.traceparent': {
    type: 'string',
    unset: 'The turn starts a new trace',
  },
  'runTurn.links': {
    type: 'TurnTraceLink[]',
  },
  'runTurn.continueFrom': {
    type: 'TurnContinueFrom',
  },
  'runTurn.continuation': {
    type: 'number',
  },
  'runTurn.promoted': {
    type: 'ToolId[]',
  },
  'runTurn.stepsTaken': {
    type: 'number',
  },
  'runTurn.speech': {
    type: 'TurnSpeech',
    unset: "The profile's speech settings",
  },
  'runTurn.resolveHost': {
    type: 'ResolveHost',
  },
  'runTurn.fetch': {
    type: 'typeof fetch',
    unset: 'The global fetch',
  },
  'runTurn.onStage': {
    type: 'StageHandler',
  },
  'runTurn.onAgentCall': {
    type: 'AgentCallHook',
    unset: 'The agent runs on what the model sent',
  },
  'runTurn.onEvent': {
    type: '(event: TurnEvent) => void | Promise<void>',
  },
  'runTurn.answersHeldCall': {
    type: 'true',
  },
});

/** What the catalog records about one export: what it is and what it does. */
export type ApiExportMeta = { kind: 'function' | 'class'; doc: string };

/** What each export a builder calls by name is. */
const EXPORT_KINDS = {
  defineProfile: 'function',
  registerProfile: 'function',
  registerTool: 'function',
  registerStructured: 'function',
  registerTraceDestination: 'function',
  defineProvider: 'function',
  registerProvider: 'function',
  runTurn: 'function',
  runSession: 'function',
  runDecision: 'function',
  invokeTool: 'function',
  runTool: 'function',
  compactHistory: 'function',
  takeSlot: 'function',
  releaseSlot: 'function',
  overrideLabels: 'function',
  resetLabels: 'function',
  TheoremError: 'class',
} as const satisfies Record<string, ApiExportMeta['kind']>;

/** The catalog of the exports a builder calls by name, keyed by that name; each doc is its JSDoc. */
export const API_EXPORTS: Record<keyof typeof EXPORT_KINDS, ApiExportMeta> = Object.fromEntries(
  Object.entries(EXPORT_KINDS).map(([name, kind]) => [
    name,
    { kind, doc: EXPORT_DOCS[name] ?? '' },
  ]),
) as Record<keyof typeof EXPORT_KINDS, ApiExportMeta>;
