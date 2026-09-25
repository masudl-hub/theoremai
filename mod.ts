/**
 * THEOREM public API.
 *
 * Import this entrypoint when an application wants the complete kernel surface:
 * profile registration, turn execution, provider constructors, guardrails,
 * observability sinks, and public type contracts.
 *
 * @example
 * ```ts
 * import { defineProfile, registerProfile, runTurn } from "jsr:@theoremai/agents";
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

export type { ErrorCopy, ErrorKind, TheoremErrorOptions } from './src/guardrails/error.ts';
export {
  describeError,
  ERROR_KINDS,
  errorKind,
  isAbortError,
  publicError,
  TheoremError,
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
  ClientLexiconKey,
  LexiconKey,
  LexiconOverrides,
  LexiconParams,
} from './src/guardrails/lexicon.ts';
export {
  CLIENT_LEXICON_KEYS,
  LEXICON_KEYS,
  lexiconDefault,
  lexiconText,
  overrideLexicon,
  resetLexicon,
} from './src/guardrails/lexicon.ts';
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
  LiveHeldOutput,
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
  QuotaGuardrailSpec,
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
  abortLiveOutboundTurn,
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
  quotaExhausted,
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
  sanitizeTurnRequestWithEvents,
} from './src/guardrails/sanitize.ts';
export type { CompactionSplit, CompactionTokens } from './src/kernel/engine/compaction.ts';
export {
  compactionMeter,
  compactionNeeded,
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
  MediaPayload,
  MediaTokenFamily,
  TokenCount,
  TokenEstimator,
} from './src/kernel/engine/token-estimate.ts';
export {
  loadTokenEstimator,
  mediaTokenFamily,
  TOKEN_TEXT_ENCODING,
} from './src/kernel/engine/token-estimate.ts';
export { sumTokens } from './src/kernel/engine/usage.ts';
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
export type { AttachmentFacts, AttachmentRules } from './src/kernel/registry/attachments.ts';
export {
  assertTurnAttachments,
  attachmentIssueCopy,
  attachmentIssues,
  attachmentIssueText,
  attachmentsRefused,
  maxBytesForMime,
  requireMediaLimits,
  resolveMediaLimits,
  sanitizeCsvText,
  sanitizeTurnBlobs,
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
  AWAITING_USER_INPUT_KINDS,
  AWAITING_USER_INPUT_STATUS,
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
  isToolGateKind,
  isTurnInjectStage,
  isTurnStage,
  isValidPair,
  isValidProfileProtocol,
  KEY_SLOTS,
  LIVE_ACTIVITY_HANDLINGS,
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
  SPEECH_AUDIO_FORMATS,
  STREAM_MODES,
  SUMMARY_MODES,
  speechFormatsForProtocol,
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
} from './src/kernel/schema.ts';
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
} from './src/kernel/stages.ts';
export {
  applyStageResult,
  isAwaitingUserInput,
  parseAwaitingUserInput,
  parseToolGate,
  STAGE_AFFORDANCE_MATRIX,
  STAGE_AFFORDANCES,
  stageAllowsAffordance,
  stageEventFields,
} from './src/kernel/stages.ts';
export type {
  MediaTurnBehaviourSpec,
  ProfileTurnBehaviourSpec,
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './src/kernel/stop.ts';
export {
  AUTO_CONTINUE_DELAY_MS,
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
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpSpan,
  OtlpTraceRequest,
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  SpanHandle,
  SpanLinkInput,
  SpanOptions,
  TraceAttributeGroup,
  TraceAttributeMeta,
  TraceAttributes,
  TraceAttributeValue,
  TraceBytes,
  TraceClock,
  TraceContent,
  TraceDestination,
  TraceEventMeta,
  TraceIncludeSpec,
  TraceJson,
  TraceOptionMeta,
  TraceRecord,
  TraceScrubSpec,
  TraceSink,
  TraceSpan,
  TraceSpanEvent,
  TraceSpanKind,
  TraceSpanLink,
  TraceSpanMeta,
  TraceSpanStatus,
  TraceSpanType,
  TraceTree,
  TraceValueFormat,
  TraceWriteContext,
} from './src/observability/mod.ts';
export {
  buildRecord,
  clearTraceDestinations,
  contentOf,
  getTraceDestination,
  inlineContent,
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
  resolveTraceWriter,
  startTrace,
  TRACE_ATTRIBUTE_GROUPS,
  TRACE_FIELDS,
  TRACE_SPAN_TYPES,
  TRACE_STATUS,
  toOtlpJson,
  traceAttributeMeta,
  traceBytes,
  traceContent,
  traceEventAttributeMeta,
  traceEventMeta,
  traceJson,
  traceSpanMeta,
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
