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
export { standardEgressEnforce } from './egress.ts';
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
  PROJECT_ID_MAX,
  redactSensitiveOnly,
  sanitizeProjectId,
  sanitizeText,
  sanitizeTurnRequest,
  sanitizeTurnRequestForTrace,
} from './sanitize.ts';
export { sensitiveSpans } from './sensitive.ts';
