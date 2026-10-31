/**
 * THEOREM's complete public API: profiles, turns, providers, guardrails, observability and
 * types. The narrower subpath exports carry parts of it without the rest.
 *
 * @module
 */

/** Compose with this `z`: two copies of zod, even at one version, do not mix. */
export { z } from 'zod';
export type {
  ErrorCopies,
  ErrorCopy,
  ErrorKind,
  TheoremErrorOptions,
} from './src/guardrails/error.ts';
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
  errorCopiesSchema,
  errorKindSchema,
  guardrailEventSchema,
} from './src/guardrails/event-schemas.ts';
export {
  guardrailFromHits,
  guardrailFromVerdict,
  guardrailTurnEvent,
  projectGuardrailTurnEvent,
} from './src/guardrails/events.ts';
export {
  hitFromSpan,
  projectGuardrailEvent,
} from './src/guardrails/hits.ts';
export type {
  ClientLabelKey,
  LabelKey,
  LabelOverrides,
  LabelParams,
} from './src/guardrails/labels.ts';
export {
  CLIENT_LABEL_KEYS,
  LABEL_KEYS,
  labelDefault,
  labelText,
  overrideLabels,
  resetLabels,
} from './src/guardrails/labels.ts';
export type {
  AdvisoryLevel,
  BlockedReplyOnBlock,
  BlockedReplySpec,
  CanaryGateResult,
  CanaryGateSession,
  CanaryStreamGate,
  DecisionDisclosureEnforcer,
  DecisionDisclosureVerdict,
  DecisionGuardrailsSpec,
  DestinationGate,
  DestinationVerdict,
  Directive,
  DirectiveSignal,
  GivenUrls,
  GuardedToolText,
  GuardrailAction,
  GuardrailContext,
  GuardrailEvent,
  GuardrailHit,
  GuardrailStage,
  HostGuardrailsSpec,
  InspectedToolArguments,
  LiveHeldOutput,
  LiveOutboundBatchResult,
  LiveOutboundGateSession,
  NameAllow,
  NetworkGuardrailSpec,
  OutboundPayload,
  ProfileGuardrailsSpec,
  ProgressiveYieldGate,
  ProgressiveYieldGateOptions,
  ProgressiveYieldResult,
  Provenance,
  QuotaGuardrailSpec,
  ResolvedGuardrailPolicy,
  ScanText,
  SensitiveGroup,
  SensitiveSelection,
  SensitiveSwitches,
  Severity,
  TaintGate,
  TaintGuardrailSpec,
  ToolOrigin,
  TrustLevel,
  TurnDestinations,
  TurnTaint,
  UrlAllow,
  Verdict,
} from './src/guardrails/mod.ts';
export {
  ADVISORY_LEVELS,
  abortLiveOutboundTurn,
  addGivenDestinations,
  addHistoryDestinations,
  addRequestDestinations,
  addResultDestinations,
  BLOCKED_REPLY_ON_BLOCK,
  bindCanary,
  checkDestinationGate,
  checkTaintGate,
  composeToolText,
  createCanaryGateSession,
  createCanaryStreamGate,
  createLiveOutboundGateSession,
  createOutboundProgressiveGate,
  createProgressiveYieldGate,
  DESTINATION_GATES,
  DIRECTIVE_SIGNALS,
  directives,
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
  mintCanary,
  OMIT_CANARY,
  processLiveOutboundBatch,
  recordTaint,
  redactCanary,
  resolveGuardrailPolicy,
  SEVERITIES,
  scanTextForCanaryLeak,
  scanTextOf,
  TAINT_GATES,
  TOOL_CLOSE,
  TOOL_ORIGINS,
  TRUST_LEVELS,
  textForScan,
  toolCallEvent,
  turnDestinations,
  wrapToolData,
  wrapUserData,
} from './src/guardrails/mod.ts';
export type {
  DnsOverHttpsOptions,
  GuardedFetchOptions,
  ResolveHost,
} from './src/guardrails/network.ts';
export {
  assertSafeUrl,
  dnsOverHttpsResolver,
  fetchGuarded,
  isLocalhostName,
  isPrivateOrLocalAddress,
} from './src/guardrails/network.ts';
export type { QuotaSlotStatus } from './src/guardrails/quota.ts';
export {
  clientIp,
  quotaBusy,
  quotaExhausted,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from './src/guardrails/quota.ts';
export type { SanitizedTurnRequest } from './src/guardrails/sanitize.ts';
export {
  sanitizeProjectId,
  sanitizeTurnRequest,
  sanitizeTurnRequestWithEvents,
} from './src/guardrails/sanitize.ts';
export type { ProviderStateRebuilt } from './src/kernel/checkpoint.ts';
export {
  historyHash,
  providerCheckpointSchema,
  providerContinuationSchema,
  providerWarningSchema,
} from './src/kernel/checkpoint.ts';
export {
  clearProfiles,
  compactHistory,
  getProfile,
  getProvider,
  getStructured,
  getTool,
  hasProfile,
  hasTool,
  invokeTool,
  invokeToolStep,
  listProfiles,
  listProtocols,
  listProviders,
  listTools,
  projectProfile,
  registerProfile,
  registerProfiles,
  registerProvider,
  registerStructured,
  registerTool,
  registerTools,
  requireTool,
  resetTools,
  resolveTurn,
  runDecision,
  runEmbedding,
  runSession,
  runTool,
  runToolStep,
  runTurn,
} from './src/kernel/default-scope.ts';
export { resolveTurnSystemPrompt } from './src/kernel/registry/system-prompt.ts';
export { systemLinesProblem } from './src/kernel/system-lines.ts';
export type { CompactionSplit, CompactionTokens } from './src/kernel/engine/compaction.ts';
export {
  compactionMeter,
  compactionNeeded,
  resolveCompactionTokens,
  resolveHistoryTokens,
  shouldCompact,
  splitForCompaction,
} from './src/kernel/engine/compaction.ts';
export { validateDecisionRequest } from './src/kernel/engine/decision.ts';
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
export type { RunSessionOptions, SignInGatePolicy } from './src/kernel/engine/session/mod.ts';
export type {
  TokenCount,
  TokenEstimator,
} from './src/kernel/engine/token-estimate.ts';
export {
  loadTokenEstimator,
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
export type { RuntimeAbilities } from './src/kernel/protocols/binding.ts';
export {
  checkBinding,
  commonModelSettingsSchema,
  decisionModelBindingSchema,
  keySlotSchema,
  keySlotsOf,
  modelBindingSchema,
} from './src/kernel/protocols/binding.ts';
export { providerLimitsSchema } from './src/kernel/protocols/limits.ts';
export type { CallSetup, KeyCheck, ProtocolCall } from './src/kernel/protocols/runtime.ts';
export { callProtocol, checkKey, plainWebSocket } from './src/kernel/protocols/runtime.ts';
export type { AttachmentFacts, AttachmentRules } from './src/kernel/registry/attachments.ts';
export {
  assertTurnAttachments,
  attachmentIssueCopy,
  attachmentIssues,
  attachmentIssueText,
  attachmentsRefused,
  base64Bytes,
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
export type { EmbeddingRules } from './src/kernel/registry/embedding-rules.ts';
export { embeddingMediaIssues, embeddingRules } from './src/kernel/registry/embedding-rules.ts';
export type { KernelRegistry } from './src/kernel/registry/kernel-registry.ts';
export { createKernelRegistry } from './src/kernel/registry/kernel-registry.ts';
export type {
  EmbeddingProfileDefinition,
  ImageProfileDefinition,
  LiveProfileDefinition,
  ProfileDefinition,
  ProfileDefinitionBase,
  ProfileRegistry,
  SpeechProfileDefinition,
  TextProfileDefinition,
} from './src/kernel/registry/profiles.ts';
export { createProfileRegistry, defineProfile } from './src/kernel/registry/profiles.ts';
export { pickModel } from './src/kernel/registry/resolve.ts';
export type { SchemaRegistry } from './src/kernel/registry/schemas.ts';
export { createSchemaRegistry } from './src/kernel/registry/schemas.ts';
export type {
  AuthUnauthenticatedPolicy,
  ContinueStopKind,
  CustomToolType,
  HttpMethod,
  StepLimitMode,
  StudioAuthType,
  ToolAccess,
  ToolAuthType,
  ToolPermission,
  ToolType,
  TurnStopKind,
} from './src/kernel/schema.ts';
export {
  API_EXPORTS,
  ATTACHMENT_ACCEPT_MIMES,
  AUTH_UNAUTHENTICATED_POLICIES,
  AWAITING_USER_INPUT_KINDS,
  AWAITING_USER_INPUT_STATUS,
  COMPACTION_METERS,
  COMPACTION_OUTCOMES,
  COMPACTION_TIMINGS,
  CONTINUE_STOP_KINDS,
  catalogPathFor,
  DYNAMIC_FIELD_PARENTS,
  EXTRA_FIELDS,
  fieldMeta,
  HTTP_METHODS,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  isKeySlotName,
  isToolGateKind,
  isTurnInjectStage,
  isTurnStage,
  KEY_SLOT_NAME,
  LIVE_ACTIVITY_HANDLINGS,
  LIVE_END_SENSITIVITIES,
  LIVE_START_SENSITIVITIES,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  MEDIA_WILDCARDS,
  PROFILE_FIELDS,
  PROFILE_HANDLE_MAX_CHARS,
  PROFILE_ID_MAX_CHARS,
  PROFILE_TYPES,
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
} from './src/kernel/schema.ts';
export type { KernelScope } from './src/kernel/scope.ts';
export { createKernelScope, defaultKernelScope } from './src/kernel/scope.ts';
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
export { authorizeToolReplay } from './src/kernel/tools/execute.ts';
export { GATE_DECISIONS, type GateDecision } from './src/kernel/tools/gate-answer.ts';
export type { MemoryToolExecutionOptions } from './src/kernel/tools/memory-execution.ts';
export { createMemoryToolExecution } from './src/kernel/tools/memory-execution.ts';
export type {
  CredentialQuery,
  McpProtocolVersion,
  McpRpcResponse,
  ToolRegistry,
} from './src/kernel/tools/mod.ts';
export {
  askUserTool,
  buildHttpToolTarget,
  createToolRegistry,
  credentialPlacement,
  executeHttpTool,
  executeMcpTool,
  formatToolResult,
  isUnsupportedMcpProtocolError,
  MCP_PROTOCOL_VERSIONS,
  mcpRequestMeta,
  parseMcpRpcResponse,
  prepareTurnToolSnapshot,
  registerHarnessTools,
  resolveToolAuth,
  UncheckedOutput,
  uncheckedOutput,
  withCredentialQuery,
} from './src/kernel/tools/mod.ts';
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
} from './src/kernel/tools/operation.ts';
export {
  savedToolInvocationSchema,
  toolInvocationHash,
  toolOperationOutcomeSchema,
} from './src/kernel/tools/operation.ts';
export type {
  SettledToolCall,
  ToolCallResult,
  ToolStepCallResult,
} from './src/kernel/tools/run.ts';
export type { ModelToolResult, PageAnswer, ToolContext } from './src/kernel/tools/types.ts';
export {
  awaitingUserInputSchema,
  type GateReference,
  gateReferenceSchema,
  isAwaitingUserInput,
  keptReply,
  reasoningPartSchema,
  TURN_EVENT_SCHEMAS,
  toolGateSchema,
  turnDoneOf,
  turnEventSchema,
  turnHistoryMessageSchema,
  turnToolSnapshotSchema,
} from './src/kernel/turn-events.ts';
export type * from './src/kernel/types.ts';
export type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpSpan,
  OtlpTraceRequest,
  ProfileObservabilitySpec,
  ResolvedObservabilityPolicy,
  ResolvedScrubSwitch,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
  ScrubSwitch,
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
  isTraceSink,
  listTraceDestinationIds,
  memorySink,
  noopSink,
  readTraceparent,
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
  traceRecordSchema,
  traceSpanMeta,
  writeTrace,
} from './src/observability/mod.ts';
export * from './src/providers/mod.ts';
