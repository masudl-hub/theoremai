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
 *   model: {
 *     allow: ["gemini35FlashLite"],
 *     config: {
 *       gemini35FlashLite: {
 *         apiId: "gemini-3.5-flash-lite",
 *         thinking: { on: "high", off: "minimal" },
 *         thinkingLevels: ["minimal", "low", "medium", "high"],
 *         summaries: { on: "auto", off: "none" },
 *         maxOutputTokens: 8192,
 *         temperature: 1,
 *         builtInTools: [],
 *       },
 *     },
 *   },
 *   tools: { allow: [] },
 *   inputs: { text: true },
 *   outputs: {},
 *   guardrails: { quota: { perDay: 100 } },
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
export type {
  CanaryGateResult,
  CanaryGateSession,
  CanaryStreamGate,
  LiveOutboundBatchResult,
  LiveOutboundGateSession,
} from './src/guardrails/mod.ts';
export {
  bindCanary,
  createCanaryGateSession,
  createCanaryStreamGate,
  createLiveOutboundGateSession,
  eventHasCanary,
  filterCanaryGatedEvents,
  finalizeLiveOutboundTurn,
  mintCanary,
  OMIT_CANARY,
  processLiveOutboundBatch,
  redactCanary,
  scanTextForCanaryLeak,
  standardEgressEnforce,
  wrapUserData,
} from './src/guardrails/mod.ts';
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
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestForTrace,
} from './src/guardrails/sanitize.ts';
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
export { runTurn } from './src/kernel/engine/runner.ts';
export type { RunSessionOptions } from './src/kernel/engine/session/mod.ts';
export { runSession } from './src/kernel/engine/session/mod.ts';
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
export {
  clampThinkingLevel,
  clampThinkingLevelForApiId,
  mediaKindForMime,
  mimeAllowed,
  mimeEssence,
  modelEntryByApiId,
  requireModelSpec,
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
export type { TurnStopKind } from './src/kernel/schema.ts';
export {
  ATTACHMENT_ACCEPT_MIMES,
  COMPACTION_METERS,
  COMPACTION_TIMINGS,
  CONTROL_IDS,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  DYNAMIC_FIELD_PARENTS,
  EGRESS_ON_BLOCK,
  EXTRA_FIELDS,
  fieldMeta,
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
} from './src/kernel/schema.ts';
export type {
  ProfileTurnResumptionSpec,
  TurnContinueFrom,
  TurnStop,
} from './src/kernel/stop.ts';
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
} from './src/kernel/stop.ts';
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
} from './src/kernel/tools/mod.ts';
export type * from './src/kernel/types.ts';
export {
  jsonlSink,
  memorySink,
  noopSink,
  resolveTraceDir,
  sinkFromDir,
  writeTrace,
} from './src/observability/trace.ts';
export type { TraceRecord } from './src/observability/trace-record.ts';
export * from './src/presets/mod.ts';
export type {
  CreateProviderOptions,
  GeminiTransport,
  KeyVault,
  LocalProviderConfig,
  OpenAiGatewayConfig,
} from './src/providers/mod.ts';
export { createProvider } from './src/providers/mod.ts';
export * from './src/interface/mod.ts';
