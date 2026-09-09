/**
 * Generic inbound and outbound guardrail primitives.
 *
 * Owns sanitization, injection/sensitive detection, canary egress gates,
 * bundled egress policy, and public error mapping.
 * App-specific policy copy remains host-owned.
 *
 * Adversarial corpus and fuzz runners: `theorum/guardrails/testing`.
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
  EGRESS_RULES,
  hitRules,
  runEnforcer,
  standardEgressEnforce,
} from './egress.ts';
export {
  describeError,
  isAbortError,
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_CANCELLED,
  PUBLIC_FILE_COUNT,
  PUBLIC_FILE_SIZE,
  PUBLIC_FILE_TYPE,
  PUBLIC_GENERIC,
  PUBLIC_IMAGE_SIZE,
  PUBLIC_UNAVAILABLE,
  publicError,
  TheorumError,
  throwIfAborted,
  toErrorEvent,
  UPSTREAM_FAILED,
} from './error.ts';
export {
  guardrailFromHits,
  guardrailFromVerdict,
  guardrailTurnEvent,
  projectGuardrailTurnEvent,
} from './events.ts';
export {
  GUARDRAIL_MATCH_PREVIEW_MAX,
  hitFromSpan,
  matchPreview,
  projectGuardrailEvent,
} from './hits.ts';
export { injectionSpans } from './injection.ts';
export type {
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
  quotaMessage,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from './quota.ts';
export {
  detectionForProfile,
  detectText,
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeHistory,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestForTrace,
  sanitizeTurnRequestWithEvents,
} from './sanitize.ts';
export { sensitiveSpans } from './sensitive.ts';
export type { ScanText } from './serialize.ts';
export { scanTextOf, textForScan } from './serialize.ts';
export {
  advisoryLevel,
  DIRECTIVE_RULES,
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
  NetworkGuardrailSpec,
  OutboundPayload,
  ProfileEgressSpec,
  ProfileGuardrailsSpec,
  Provenance,
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
