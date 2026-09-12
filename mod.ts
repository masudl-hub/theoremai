/**
 * THEORUM public API.
 *
 * Import this entrypoint when an application wants the complete kernel surface:
 * profile registration, turn execution, provider constructors, guardrails,
 * observability sinks, and public type contracts.
 *
 * @example
 * ```ts
 * import { defineProfile, registerProfile, runTurn } from "jsr:@theorum/core";
 *
 * const profile = defineProfile({
 *   id: "assistant.basic",
 *   type: "text",
 *   identity: {
 *     handle: "assistant",
 *     system: "Answer plainly.",
 *   },
 *   models: {
 *     default: {
 *       protocol: "openAi",
 *       provider: "openrouter",
 *       apiId: "perplexity/sonar",
 *       efforts: { normal: "minimal" },
 *       summaries: false,
 *       maxOutputTokens: 8192,
 *       temperature: 1,
 *     },
 *   },
 *   maxSteps: 1,
 *   tools: { allow: [] },
 *   inputs: { text: true },
 *   outputs: {
 *     streaming: { streamThoughts: false },
 *   },
 *   guardrails: {
 *     quota: { perDay: 100 },
 *   },
 * });
 *
 * registerProfile(profile);
 * ```
 *
 * @module
 */

export {
  describeError,
  isAbortError,
  PUBLIC_CANARY,
  publicError,
  TheorumError,
  throwIfAborted,
  toErrorEvent,
} from './src/guardrails/error.ts';
export {
  guardrailFromHits,
  guardrailFromVerdict,
  guardrailTurnEvent,
  projectGuardrailTurnEvent,
} from './src/guardrails/events.ts';
export {
  GUARDRAIL_MATCH_PREVIEW_MAX,
  hitFromSpan,
  matchPreview,
  projectGuardrailEvent,
} from './src/guardrails/hits.ts';
export type {
  AdvisoryLevel,
  CanaryGateResult,
  CanaryGateSession,
  CanaryStreamGate,
  DetectionOptions,
  EgressEnforcer,
  EgressOnBlock,
  GuardedToolText,
  GuardrailAction,
  GuardrailContext,
  GuardrailEvent,
  GuardrailHit,
  GuardrailStage,
  HostGuardrailsSpec,
  LiveOutboundBatchResult,
  LiveOutboundGateSession,
  NetworkGuardrailSpec,
  OutboundPayload,
  ProfileEgressSpec,
  ProfileGuardrailsSpec,
  ProgressiveYieldGate,
  ProgressiveYieldGateOptions,
  ProgressiveYieldResult,
  Provenance,
  ResolvedGuardrailPolicy,
  ScanText,
  Severity,
  TaintGate,
  TaintGuardrailSpec,
  ToolOrigin,
  TrustLevel,
  TurnTaint,
  Verdict,
} from './src/guardrails/mod.ts';
export {
  ADVISORY_LEVELS,
  bindCanary,
  checkTaintGate,
  collectEgressHits,
  composeToolText,
  createCanaryGateSession,
  createCanaryStreamGate,
  createLiveOutboundGateSession,
  createOutboundProgressiveGate,
  createProgressiveYieldGate,
  DEFAULT_HOLDBACK,
  DIRECTIVE_RULES,
  detectionForTrust,
  directiveHits,
  EGRESS_ON_BLOCK,
  EGRESS_RULES,
  eventHasCanary,
  filterCanaryGatedEvents,
  finalizeLiveOutboundTurn,
  GUARDRAIL_STAGES,
  guardToolFailureText,
  guardToolResult,
  hitRules,
  inspectToolArguments,
  isRemoteOrigin,
  isSuspicious,
  isTainted,
  looksDirective,
  mintCanary,
  OMIT_CANARY,
  processLiveOutboundBatch,
  recordTaint,
  redactCanary,
  resolveGuardrailPolicy,
  runEnforcer,
  SEVERITIES,
  scanTextForCanaryLeak,
  scanTextOf,
  standardEgressEnforce,
  TAINT_GATES,
  TOOL_CLOSE,
  TOOL_ORIGINS,
  TRUST_LEVELS,
  textForScan,
  toolCallEvent,
  wrapToolData,
  wrapUserData,
} from './src/guardrails/mod.ts';
export {
  assertSafeUrl,
  isLocalhostName,
  isPrivateOrLocalAddress,
} from './src/guardrails/network.ts';
export type { QuotaSlotStatus } from './src/guardrails/quota.ts';
export {
  clientIp,
  quotaMessage,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from './src/guardrails/quota.ts';
export {
  detectionForProfile,
  detectText,
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestForTrace,
  sanitizeTurnRequestWithEvents,
} from './src/guardrails/sanitize.ts';
export * from './src/interface/mod.ts';
export type { CompactionSplit, CompactionTokens } from './src/kernel/engine/compaction.ts';
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
} from './src/kernel/engine/compaction.ts';
export { prepareLiveInboundText } from './src/kernel/engine/live-inbound.ts';
export type { LiveIngressChannel } from './src/kernel/engine/live-ingress.ts';
export {
  assertLiveIngress,
  assertLiveIngressConfigured,
  hasAnyLiveIngress,
  liveIngressChannelDefault,
  liveIngressEnabled,
  liveIngressEnabledFromSpec,
} from './src/kernel/engine/live-ingress.ts';
export { runTurn } from './src/kernel/engine/runner.ts';
export type { RunSessionOptions } from './src/kernel/engine/session/mod.ts';
export { runSession } from './src/kernel/engine/session/mod.ts';
export type {
  ProfileGraphEditor,
  ProfileGraphFacet,
  ProfileGraphFacetId,
  ProfileGraphRole,
} from './src/kernel/profile-graph.ts';
export {
  PROFILE_GRAPH,
  profileGraphFacet,
  spineFacetsForProfileType,
} from './src/kernel/profile-graph.ts';
export {
  assertAttachmentLimits,
  fileTooLargeMessage,
  maxBytesForMime,
  requireMediaLimits,
  resolveMediaLimits,
  sanitizeCsvText,
  sanitizeTurnBlobs,
  sanitizeTurnBlobsForProfile,
  tooManyFilesMessage,
  turnTooLargeMessage,
} from './src/kernel/registry/attachments.ts';
export type { MediaInputChannel } from './src/kernel/registry/catalog.ts';
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaChannelForMime,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelBinding,
} from './src/kernel/registry/catalog.ts';
export type {
  ImageProfileDefinition,
  LiveProfileDefinition,
  ProfileDefinition,
  ProfileDefinitionBase,
  SpeechProfileDefinition,
  TextProfileDefinition,
} from './src/kernel/registry/profiles.ts';
export {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from './src/kernel/registry/profiles.ts';
export { pickModel, projectProfile, resolveTurn } from './src/kernel/registry/resolve.ts';
export { getStructured, registerStructured } from './src/kernel/registry/schemas.ts';
export type {
  AuthUnauthenticatedPolicy,
  ContinueStopKind,
  CustomToolType,
  HttpMethod,
  PlaygroundAuthType,
  ToolAccess,
  ToolAuthType,
  ToolPermission,
  ToolType,
  TurnStopKind,
} from './src/kernel/schema.ts';
export {
  ATTACHMENT_ACCEPT_MIMES,
  AUTH_UNAUTHENTICATED_POLICIES,
  COMPACTION_METERS,
  COMPACTION_TIMINGS,
  CONTINUE_STOP_KINDS,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  coerceSpeechFormat,
  DYNAMIC_FIELD_PARENTS,
  EXTRA_FIELDS,
  fieldMeta,
  HTTP_METHODS,
  isSpeechFormatAllowedForProtocol,
  isValidPair,
  isValidProfileProtocol,
  KEY_SLOTS,
  LIVE_ACTIVITY_HANDLINGS,
  LIVE_CONTEXT_COMPRESSIONS,
  LIVE_SPEECH_SENSITIVITIES,
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
} from './src/kernel/schema.ts';
export type {
  ProfileTurnBehaviourSpec,
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './src/kernel/stop.ts';
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
} from './src/kernel/stop.ts';
export type { McpProtocolVersion, McpRpcResponse } from './src/kernel/tools/mod.ts';
export {
  buildHttpToolTarget,
  executeHttpTool,
  executeMcpTool,
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
} from './src/kernel/tools/mod.ts';
export type * from './src/kernel/types.ts';
export type {
  JsonlSinkOptions,
  JsonlTraceDestination,
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  TraceDestination,
  TraceIncludeSpec,
  TraceRecord,
  TraceScrubSpec,
  TraceSink,
} from './src/observability/mod.ts';
export {
  clearTraceDestinations,
  getTraceDestination,
  isJsonlTraceDestination,
  isTraceSink,
  jsonlDestination,
  jsonlSink,
  listTraceDestinationIds,
  memorySink,
  noopSink,
  registerTraceDestination,
  requireTraceDestination,
  resolveObservabilityPolicy,
  resolveTraceDir,
  resolveTraceWriter,
  sinkFromDir,
  writeTrace,
} from './src/observability/mod.ts';
export * from './src/presets/mod.ts';
export type {
  CreateProviderOptions,
  GeminiTransport,
  KeyVault,
  LocalProviderConfig,
  OpenAiGatewayConfig,
} from './src/providers/mod.ts';
export { createProvider } from './src/providers/mod.ts';
