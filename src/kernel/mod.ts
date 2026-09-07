/**
 * Profile, turn, tool, provider, egress, and event contracts for THEORUM.
 *
 * @module
 */

export * from './auth/mod.ts';
export type { CompactionSplit, CompactionTokens } from './engine/compaction.ts';
export {
  compactionMeter,
  compactionNeeded,
  estimateHistoryTokens,
  HISTORY_MEDIA_TOKENS,
  HISTORY_TEXT_ENCODING,
  resolveCompactionTokens,
  resolveHistoryTokens,
  shouldCompact,
  splitForCompaction,
} from './engine/compaction.ts';
export type { LiveIngressChannel } from './engine/live-ingress.ts';
export {
  assertLiveIngress,
  assertLiveIngressConfigured,
  hasAnyLiveIngress,
  liveIngressChannelDefault,
  liveIngressEnabled,
  liveIngressEnabledFromSpec,
} from './engine/live-ingress.ts';
export { runTurn } from './engine/runner.ts';
export type { RunSessionOptions } from './engine/session/mod.ts';
export { runSession } from './engine/session/mod.ts';
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelSpec,
} from './registry/catalog.ts';
export type {
  ImageProfileDefinition,
  LiveProfileDefinition,
  ProfileDefinition,
  ProfileDefinitionBase,
  SpeechProfileDefinition,
  TextProfileDefinition,
} from './registry/profiles.ts';
export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from './registry/profiles.ts';
export { projectProfile, projectProfileObject, resolveTurn } from './registry/resolve.ts';
export { getStructured, registerStructured } from './registry/schemas.ts';
export {
  ATTACHMENT_ACCEPT_MIMES,
  COMPACTION_METERS,
  COMPACTION_TIMINGS,
  CONTROL_IDS,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  EGRESS_ON_BLOCK,
  EXTRA_FIELDS,
  fieldMeta,
  isValidPair,
  isValidProfileProtocol,
  KEY_SLOTS,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  MEDIA_WILDCARDS,
  OVERFLOW_KEY_SLOTS,
  PROFILE_FIELDS,
  PROFILE_TYPE_PROTOCOLS,
  PROFILE_TYPES,
  PROTOCOL_PROVIDERS,
  PROTOCOLS,
  PROVIDERS,
  protocolsFor,
  protocolsForProfileType,
  providersFor,
  SCHEMA_ENFORCEMENTS,
  SPEECH_AUDIO_FORMATS,
  STREAM_MODES,
  SUMMARY_MODES,
  THINKING_LEVELS,
  TOOL_ACCESS,
  TOOL_LOAD_TIERS,
  TOOL_PERMISSION,
  TOOL_TYPES,
  TURN_STOP_KINDS,
  VOICE_ACCEPT_MIMES,
} from './schema.ts';
export type { ProfileTurnResumptionSpec, TurnContinueFrom, TurnStop } from './stop.ts';
export {
  AUTO_CONTINUE_DELAY_MS,
  CONTINUE_INSTRUCTION,
  DEFAULT_AUTO_CONTINUE,
  GenerationStopError,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
  turnStopFromInteractionStatus,
  turnStopFromOpenAiFinishReason,
} from './stop.ts';
export {
  executeHttpTool,
  executeMcpTool,
  executeRegisteredTool,
  formatToolResult,
  getTool,
  hasTool,
  invokeTool,
  listBuiltinIds,
  listFunctionIds,
  listTools,
  prepareTurnToolSnapshot,
  registerHarnessTools,
  registerTool,
  registerTools,
  requireTool,
  resetTools,
  resolveToolAuth,
} from './tools/mod.ts';
export type * from './types.ts';
