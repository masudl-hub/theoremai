/**
 * Profile, turn, tool, provider, egress, and event contracts for THEOREM.
 *
 * @module
 */

export * from './auth/mod.ts';
export {
  clearProfiles,
  compactHistory,
  getProfile,
  getProvider,
  getStructured,
  getTool,
  hasProfile,
  hasProvider,
  hasTool,
  invokeTool,
  listProfiles,
  listProviders,
  listTools,
  projectProfile,
  registerProfile,
  registerProfiles,
  registerProvider,
  registerProviders,
  registerStructured,
  registerTool,
  registerTools,
  requireProvider,
  requireTool,
  resetProviders,
  resetTools,
  resolveTurn,
  runDecision,
  runSession,
  runTurn,
  turnShortfalls,
} from './default-scope.ts';
export type { CompactionSplit, CompactionTokens } from './engine/compaction.ts';
export {
  compactionMeter,
  compactionNeeded,
  resolveCompactionTokens,
  resolveHistoryTokens,
  shouldCompact,
  splitForCompaction,
} from './engine/compaction.ts';
export type { RunDecisionOptions } from './engine/decision.ts';
export { DecisionError, validateDecisionRequest } from './engine/decision.ts';
export type { LiveIngressChannel } from './engine/live-ingress.ts';
export {
  assertLiveIngress,
  assertLiveIngressConfigured,
  hasAnyLiveIngress,
  liveIngressChannelDefault,
  liveIngressEnabled,
  liveIngressEnabledFromSpec,
} from './engine/live-ingress.ts';
export type { RunSessionOptions, SignInGatePolicy } from './engine/session/mod.ts';
export type {
  MediaPayload,
  MediaTokenFamily,
  TokenCount,
  TokenEstimator,
} from './engine/token-estimate.ts';
export {
  loadTokenEstimator,
  mediaTokenFamily,
  TOKEN_TEXT_ENCODING,
} from './engine/token-estimate.ts';
export { sumTokens } from './engine/usage.ts';
export { isMediaRefPart, wireInteractionPart } from './interaction-parts.ts';
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
export { unsetValue } from './profile-presence.ts';
export { outOfScopeFields, profileTypesForField } from './profile-scope.ts';
export type {
  CapabilitySupport,
  CredentialContext,
  CredentialResolver,
  DefinedProvider,
  JsonObject,
  JsonValue,
  OpenProviderWebSocket,
  ProviderAdapter,
  ProviderBuiltinSpec,
  ProviderCapabilities,
  ProviderCheckpoint,
  ProviderContentEvent,
  ProviderContext,
  ProviderContinuationPolicy,
  ProviderCredential,
  ProviderDecisionRequest,
  ProviderDefinition,
  ProviderHostOptions,
  ProviderLimits,
  ProviderLiveConnection,
  ProviderModelEvent,
  ProviderModelSettings,
  ProviderOperations,
  ProviderRegistry,
  ProviderRequest,
  ProviderSessionRequest,
  ProviderToolResult,
  ProviderTurnRequest,
  ProviderVault,
  ProviderWait,
  ProviderWarning,
  RegisteredProvider,
  ResolvedProviderModel,
} from './provider-contract.ts';
export {
  commonModelSettingsSchema,
  createProviderRegistry,
  decisionModelBindingSchema,
  defineProvider,
  jsonObjectSchema,
  jsonValueSchema,
  keySlotSchema,
  modelBindingSchema,
  providerCapabilitiesSchema,
  providerCheckpointSchema,
  providerContinuationSchema,
  providerLimitsSchema,
  providerWarningSchema,
  resolveProviderLimits,
} from './provider-contract.ts';
export type { MediaInputChannel } from './registry/catalog.ts';
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaChannelForMime,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelBinding,
} from './registry/catalog.ts';
export type { KernelRegistry } from './registry/kernel-registry.ts';
export { createKernelRegistry } from './registry/kernel-registry.ts';
export type {
  DecisionProfileDefinition,
  HostProfileDefinition,
  ImageProfileDefinition,
  LiveProfileDefinition,
  ProfileDefinition,
  ProfileDefinitionBase,
  ProfileRegistry,
  SpeechProfileDefinition,
  TextProfileDefinition,
} from './registry/profiles.ts';
export { createProfileRegistry, defineProfile } from './registry/profiles.ts';
export { projectProfileObject, requireModelProfile } from './registry/resolve.ts';
export type { SchemaRegistry } from './registry/schemas.ts';
export { createSchemaRegistry } from './registry/schemas.ts';
export type { TurnShortfall } from './registry/turn-check.ts';
export { resolveKeySlot } from './registry/vault.ts';
export type {
  AuthUnauthenticatedPolicy,
  CustomToolType,
  HttpMethod,
  StudioAuthType,
  ToolAccess,
  ToolAuthType,
  ToolPermission,
  ToolType,
} from './schema.ts';
export {
  API_EXPORTS,
  ATTACHMENT_ACCEPT_MIMES,
  AUTH_UNAUTHENTICATED_POLICIES,
  AWAITING_USER_INPUT_KINDS,
  AWAITING_USER_INPUT_STATUS,
  CACHE_MODES,
  CACHE_TTLS,
  COMPACTION_METERS,
  COMPACTION_OUTCOMES,
  COMPACTION_TIMINGS,
  CONTINUE_STOP_KINDS,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  EXTRA_FIELDS,
  fieldMeta,
  HTTP_METHODS,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  isKeySlotName,
  isToolGateKind,
  isTurnInjectStage,
  isTurnStage,
  isValidPair,
  isValidProfileProtocol,
  KEY_SLOT_NAME,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  MEDIA_WILDCARDS,
  PROFILE_FIELDS,
  PROFILE_HANDLE_MAX_CHARS,
  PROFILE_ID_MAX_CHARS,
  PROFILE_TYPE_PROTOCOLS,
  PROFILE_TYPES,
  PROTOCOL_PROVIDERS,
  PROTOCOLS,
  PROVIDERS,
  protocolsFor,
  protocolsForProfileType,
  providersFor,
  REQUEST_FIELDS,
  SPEECH_AUDIO_FORMATS,
  STREAM_MODES,
  STUDIO_AUTH_TYPES,
  SUMMARY_MODES,
  THINKING_LEVELS,
  TOOL_ACCESS,
  TOOL_AUTH_TYPES,
  TOOL_GATE_KINDS,
  TOOL_LOAD_TIERS,
  TOOL_PERMISSION,
  TOOL_TYPES,
  TURN_INJECT_STAGES,
  TURN_STAGES,
  TURN_STOP_KINDS,
  VOICE_ACCEPT_MIMES,
} from './schema.ts';
export type { KernelScope } from './scope.ts';
export { createKernelScope, defaultKernelScope } from './scope.ts';
export type {
  AwaitingUserInput,
  StageAffordance,
  StageApplyInput,
  StageApplyOutput,
  StageApplyWarning,
  StageApplyWarningCode,
  StageContext,
  StageEventExtra,
  StageHandler,
  StageMutate,
  StageResult,
} from './stages.ts';
export {
  applyStageResult,
  isAwaitingUserInput,
  STAGE_AFFORDANCE_MATRIX,
  STAGE_AFFORDANCES,
  stageAllowsAffordance,
  stageEventFields,
} from './stages.ts';
export type {
  MediaTurnBehaviourSpec,
  ProfileTurnBehaviourSpec,
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './stop.ts';
export {
  AUTO_CONTINUE_DELAY_MS,
  CONTINUE_INSTRUCTION_TYPES,
  DEFAULT_ALLOW_CONTINUE,
  DEFAULT_AUTO_CONTINUE,
  GenerationStopError,
  isContinueStopKind,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  profileAllowsInject,
  profileAllowsSteering,
  profileTurnResumption,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
  turnStopFromInteractionStatus,
  turnStopFromOpenAiFinishReason,
} from './stop.ts';
export { systemPromptProblem } from './system-parts.ts';
export { activityLabelProblem } from './tools/activity-label.ts';
export { agentToolInputFor, agentToolOutput } from './tools/agent.ts';
export {
  type AnsweredGate,
  answerGatedCall,
  GATE_DECISIONS,
  type GateAnswerRequest,
  type GateDecision,
  gateExpired,
  type HeldGatedCall,
  resolveGateTtlMs,
  sessionPermissionsAfterApproval,
  type ToolGateAuth,
} from './tools/gate-answer.ts';
export type {
  CredentialQuery,
  McpProtocolVersion,
  McpRpcResponse,
  ToolRegistry,
} from './tools/mod.ts';
export {
  askUserTool,
  authorizeToolReplay,
  coerceToolResultParts,
  createToolRegistry,
  credentialPlacement,
  executeHttpTool,
  executeMcpTool,
  executeRegisteredTool,
  formatToolResult,
  isUnsupportedMcpProtocolError,
  leanToolResultData,
  MCP_PROTOCOL_VERSIONS,
  parseMcpRpcResponse,
  prepareTurnToolSnapshot,
  projectForModel,
  registerHarnessTools,
  resolveToolAuth,
  withCredentialQuery,
} from './tools/mod.ts';
export type {
  BeginToolOperationResult,
  PageToolDispatch,
  PageToolExecution,
  SavedToolInvocation,
  TerminalToolEvent,
  ToolExecutionCoordinator,
  ToolOperationClaim,
  ToolOperationIdentity,
  ToolOperationOutcome,
  ToolOperationUncertainty,
} from './tools/operation.ts';
export {
  savedToolInvocationSchema,
  toolInvocationHash,
  toolOperationOutcomeSchema,
} from './tools/operation.ts';
export { jsonSchemaFromZod } from './tools/schema.ts';
export { CredentialRefusedError } from './tools/signed-in-fetch.ts';
export type {
  ModelToolResult,
  PageAnswer,
  ToolAuthConfig,
  ToolContext,
  ToolLabels,
} from './tools/types.ts';
export {
  awaitingUserInputSchema,
  type GateReference,
  gateReferenceSchema,
  keptReply,
  TURN_EVENT_SCHEMAS,
  toolGateSchema,
  turnDoneOf,
  turnEventSchema,
  turnHistoryMessageSchema,
  turnToolSnapshotSchema,
} from './turn-events.ts';
export type * from './types.ts';
export { base64ToBytes, bytesToBase64 } from './util/base64.ts';
export type { Equals } from './util/exact-type.ts';
export { isRecord } from './util/record.ts';
