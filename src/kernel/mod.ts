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
export type {
  ProfileGraphEditor,
  ProfileGraphFacet,
  ProfileGraphFacetId,
  ProfileGraphRole,
} from './profile-graph.ts';
export {
  PROFILE_GRAPH,
  profileGraphFacet,
  spineFacetsForProfileType,
} from './profile-graph.ts';
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelBinding,
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
export type {
  AuthUnauthenticatedPolicy,
  CustomToolType,
  HttpMethod,
  PlaygroundAuthType,
  ToolAccess,
  ToolAuthType,
  ToolPermission,
  ToolType,
} from './schema.ts';
export {
  ATTACHMENT_ACCEPT_MIMES,
  AUTH_UNAUTHENTICATED_POLICIES,
  COMPACTION_METERS,
  COMPACTION_TIMINGS,
  CONTINUE_STOP_KINDS,
  CONTINUE_STOP_KINDS,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  coerceSpeechFormat,
  EXTRA_FIELDS,
  fieldMeta,
  HTTP_METHODS,
  isSpeechFormatAllowedForProtocol,
  isValidPair,
  isValidProfileProtocol,
  KEY_SLOTS,
  LIVE_TOOL_LOAD_TIERS,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  MEDIA_WILDCARDS,
  OVERFLOW_KEY_SLOTS,
  PLAYGROUND_AUTH_TYPES,
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
  speechFormatsForProtocol,
  THINKING_LEVELS,
  TOOL_ACCESS,
  TOOL_AUTH_TYPES,
  TOOL_LOAD_TIERS,
  TOOL_PERMISSION,
  TOOL_TYPES,
  TURN_STEER_BARRIERS,
  TURN_STOP_KINDS,
  VOICE_ACCEPT_MIMES,
} from './schema.ts';
export type {
  ProfileTurnBehaviourSpec,
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './stop.ts';
export {
  AUTO_CONTINUE_DELAY_MS,
  CONTINUE_INSTRUCTION,
  DEFAULT_ALLOW_CONTINUE,
  DEFAULT_AUTO_CONTINUE,
  GenerationStopError,
  isContinueStopKind,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  profileAllowsSteering,
  profileTurnResumption,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
  turnStopFromInteractionStatus,
  turnStopFromOpenAiFinishReason,
} from './stop.ts';
export type { McpProtocolVersion, McpRpcResponse } from './tools/mod.ts';
export {
  executeHttpTool,
  executeMcpTool,
  executeRegisteredTool,
  formatToolResult,
  getTool,
  hasTool,
  invokeTool,
  isUnsupportedMcpProtocolError,
  listBuiltinIds,
  listFunctionIds,
  listTools,
  MCP_PROTOCOL_VERSIONS,
  parseMcpRpcResponse,
  prepareTurnToolSnapshot,
  registerHarnessTools,
  registerTool,
  registerTools,
  requireTool,
  resetTools,
  resolveToolAuth,
} from './tools/mod.ts';
export type { ToolPause } from './tools/types.ts';
export type * from './types.ts';
