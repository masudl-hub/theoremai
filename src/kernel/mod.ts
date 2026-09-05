/**
 * Profile, turn, tool, provider, egress, and event contracts for THEORUM.
 *
 * @module
 */

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
export { runTurn } from './engine/runner.ts';
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelSpec,
} from './registry/catalog.ts';
export type { ProfileDefinition } from './registry/profiles.ts';
export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from './registry/profiles.ts';
export { projectProfile, resolveTurn } from './registry/resolve.ts';
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
  GEMINI_BUCKETS,
  GEMINI_FREE_BUCKETS,
  isValidPair,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  MEDIA_WILDCARDS,
  PROFILE_FIELDS,
  PROTOCOL_PROVIDERS,
  PROTOCOLS,
  PROVIDERS,
  protocolsFor,
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
} from './tools/mod.ts';
export type * from './types.ts';
