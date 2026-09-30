/**
 * Inbound and outbound guardrail primitives: sanitization, injection and sensitive detection,
 * canary egress gates, egress policy and public error mapping. App-specific policy copy stays host-owned.
 *
 * @module
 */

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
export {
  collectEgressHits,
  hitRules,
  runEnforcer,
  standardEgressEnforce,
} from './egress.ts';
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
export type { DetectionOptions } from './policy.ts';
export { detectionForTrust, resolveGuardrailPolicy } from './policy.ts';
export type {
  ProgressiveYieldGate,
  ProgressiveYieldGateOptions,
  ProgressiveYieldResult,
} from './progressive-yield.ts';
export {
  createOutboundProgressiveGate,
  createProgressiveYieldGate,
  DEFAULT_HOLDBACK,
} from './progressive-yield.ts';
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
  DIRECTIVE_RULES,
  EGRESS_RULES,
  NETWORK_RULES,
  SANITIZE_RULES,
  TOOL_RULES,
} from './rules.ts';
export {
  detectionForProfile,
  detectText,
  redactSensitiveOnly,
  sanitizeHistory,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestWithEvents,
} from './sanitize.ts';
export { sensitiveSpans } from './sensitive.ts';
export type { ScanText } from './serialize.ts';
export { scanTextOf, textForScan } from './serialize.ts';
export {
  advisoryLevel,
  directiveHits,
  looksDirective,
} from './tool-directives.ts';
export type { GuardedToolText } from './tool-result.ts';
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
  EgressEnforcer,
  EgressOnBlock,
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
  EGRESS_ON_BLOCK,
  GUARDRAIL_STAGES,
  SEVERITIES,
  TAINT_GATES,
  TOOL_ORIGINS,
  TRUST_LEVELS,
} from './types.ts';
