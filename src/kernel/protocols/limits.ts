import { z } from 'zod';

/** The budgets a provider call runs under. Each one left out is no limit: the provider's own applies. */
export interface ProviderLimits {
  /** How long one call may take, in milliseconds, retries included. */
  operationTimeoutMs?: number;
  /** How long a live session may take to open, in milliseconds. */
  connectTimeoutMs?: number;
  /** How long a live session may wait for the model to answer, in milliseconds. */
  liveStepTimeoutMs?: number;
  /** The most bytes in one record the provider sends: a stream event or a socket message. */
  maxWireRecordBytes?: number;
  /** The most bytes the provider sends for one step. */
  maxWireResponseBytes?: number;
  /** The most bytes in one event of a step. */
  maxEventBytes?: number;
  /** The most bytes in all the events of one step. */
  maxStepBytes?: number;
  /** The most events in one step. */
  maxStepEvents?: number;
  /** The most tool calls one step may ask for. */
  maxPendingToolCalls?: number;
}

const positiveBudget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timerBudget = positiveBudget.max(2147483647);
export const providerLimitsSchema: z.ZodType<ProviderLimits> = z.strictObject({
  operationTimeoutMs: timerBudget.optional(),
  connectTimeoutMs: timerBudget.optional(),
  liveStepTimeoutMs: timerBudget.optional(),
  maxWireRecordBytes: positiveBudget.optional(),
  maxWireResponseBytes: positiveBudget.optional(),
  maxEventBytes: positiveBudget.optional(),
  maxStepBytes: positiveBudget.optional(),
  maxStepEvents: positiveBudget.optional(),
  maxPendingToolCalls: positiveBudget.optional(),
});
