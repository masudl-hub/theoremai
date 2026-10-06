/**
 * Inbound and outbound guardrail primitives: sanitization, injection and sensitive detection,
 * canary egress gates, egress policy and public error mapping. App-specific policy copy stays host-owned.
 *
 * @module
 */

export type {
  Boundary,
  BoundaryMeta,
  ToolBoundary,
  ToolCrossing,
  ToolKind,
} from './boundaries.ts';
export {
  BOUNDARIES,
  BOUNDARY_META,
  TOOL_BOUNDARIES,
  TOOL_KINDS,
  toolBoundary,
} from './boundaries.ts';
export type { CanaryGateResult, CanaryStreamGate } from './canary.ts';
export {
  bindCanary,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
} from './canary.ts';
export type { CanaryGateSession } from './canary-gate.ts';
export { createCanaryGateSession, filterCanaryGatedEvents } from './canary-gate.ts';
export type { Detection, DetectOutcome } from './detect-at.ts';
export { detectAt } from './detect-at.ts';
export type {
  DetectAction,
  DetectMatrix,
  DetectMeta,
  Detector,
  DetectorConfig,
  DetectorDeclaration,
  DetectorGroup,
  DetectorRule,
  DetectorSource,
  DetectSources,
  DetectSpec,
  HostDetector,
  HostDetectorConfig,
  HostDetectorId,
  HostFind,
  HostSpan,
  ResolvedAllow,
  ResolvedDetect,
  UrlAllow,
  UrlDetector,
} from './detectors.ts';
export {
  DETECT_ACTION_META,
  DETECT_ACTIONS,
  DETECT_DEFAULTS,
  DETECTOR_BOUNDARIES,
  DETECTOR_GROUP_META,
  DETECTOR_GROUPS,
  DETECTOR_META,
  DETECTORS,
  detectProblem,
  HOST_FIND_HOLD,
  HOST_FIND_HOLD_LIVE,
  PATTERN_DETECTORS,
  resolveDetect,
} from './detectors.ts';
export { hitRules, runEnforcer } from './egress.ts';
export type { EgressPolicyOptions } from './egress-policy.ts';
export { egressPolicy } from './egress-policy.ts';
export type { CompiledEgressRules, EgressRule } from './egress-rules.ts';
export type { GivenUrls } from './egress-urls.ts';
export type { ErrorCopies, ErrorCopy, ErrorKind, TheoremErrorOptions } from './error.ts';
export {
  describeError,
  ERROR_KINDS,
  errorKind,
  isAbortError,
  isTimeoutError,
  kindOfHttpStatus,
  publicError,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  withPublicWording,
} from './error.ts';
export { errorCopiesSchema, errorKindSchema, guardrailEventSchema } from './event-schemas.ts';
export {
  guardrailFromHits,
  guardrailFromVerdict,
  guardrailTurnEvent,
  projectGuardrailTurnEvent,
} from './events.ts';
export {
  hitFromSpan,
  projectGuardrailEvent,
} from './hits.ts';
export type { CompiledPatterns, HostPattern } from './host-patterns.ts';
export { MAX_PATTERN_LENGTH, MAX_PATTERNS } from './host-patterns.ts';
export { injectionSpans } from './injection.ts';
export type { ClientLexiconKey, LexiconKey, LexiconOverrides, LexiconParams } from './lexicon.ts';
export {
  CLIENT_LEXICON_KEYS,
  LEXICON_KEYS,
  lexiconDefault,
  lexiconText,
  overrideLexicon,
  resetLexicon,
} from './lexicon.ts';
export type {
  LiveHeldOutput,
  LiveOutboundBatchResult,
  LiveOutboundGateSession,
} from './live-outbound-gate.ts';
export {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from './live-outbound-gate.ts';
export { resolveGuardrailPolicy } from './policy.ts';
export type {
  ProgressiveYieldGate,
  ProgressiveYieldGateOptions,
  ProgressiveYieldResult,
} from './progressive-yield.ts';
export {
  createOutboundProgressiveGate,
  createProgressiveYieldGate,
  DEFAULT_HOLDBACK,
  LIVE_DEFAULT_HOLDBACK,
} from './progressive-yield.ts';
export { PROMPT_ECHO_WORDS, scanTextForPromptEcho } from './prompt-echo.ts';
export type { QuotaSlotStatus } from './quota.ts';
export {
  clientIp,
  quotaExhausted,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from './quota.ts';
export type { GuardrailRule } from './rules.ts';
export {
  DETECT_RULES,
  DIRECTIVE_RULES,
  detectRule,
  EGRESS_RULES,
  NETWORK_RULES,
  TOOL_RULES,
} from './rules.ts';
export type { SanitizedTurnRequest } from './sanitize.ts';
export {
  sanitizeHistory,
  sanitizeProjectId,
  sanitizeTurnRequest,
  sanitizeTurnRequestWithEvents,
} from './sanitize.ts';
export type {
  SensitiveGroup,
  SensitiveGroups,
  SensitiveSelection,
  SensitiveSwitches,
} from './sensitive.ts';
export { SENSITIVE_GROUPS, sensitiveSpans } from './sensitive.ts';
export type { ScanText } from './serialize.ts';
export { scanTextOf, textForScan } from './serialize.ts';
export {
  advisoryLevel,
  directiveHits,
  looksDirective,
} from './tool-directives.ts';
export type { GuardedToolText, InspectedToolArguments } from './tool-result.ts';
export {
  checkTaintGate,
  composeToolText,
  guardToolFailureText,
  guardToolResult,
  inspectToolArguments,
  isRemoteOrigin,
  isSuspicious,
  isTainted,
  recordTaint,
  TOOL_CLOSE,
  toolCallEvent,
  wrapToolData,
} from './tool-result.ts';
export type {
  AdvisoryLevel,
  BlockedReplyOnBlock,
  BlockedReplySpec,
  EgressEnforcer,
  GuardrailAction,
  GuardrailContext,
  GuardrailEvent,
  GuardrailHit,
  GuardrailStage,
  HostGuardrailsSpec,
  NetworkGuardrailSpec,
  OutboundPayload,
  ProfileEgressSpec,
  ProfileGuardrailsSpec,
  Provenance,
  QuotaGuardrailSpec,
  ResolvedBlockedReply,
  ResolvedGuardrailPolicy,
  Severity,
  TaintGate,
  TaintGuardrailSpec,
  ToolOrigin,
  TrustLevel,
  TurnTaint,
  Verdict,
} from './types.ts';
export {
  ADVISORY_LEVELS,
  BLOCKED_REPLY_ON_BLOCK,
  GUARDRAIL_STAGES,
  SEVERITIES,
  TAINT_GATES,
  TOOL_ORIGINS,
  TRUST_LEVELS,
} from './types.ts';
