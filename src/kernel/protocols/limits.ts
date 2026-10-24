import { z } from 'zod';

/** The budgets a provider call runs under. Each one left out is no limit: the provider's own applies. */
export interface ProviderLimits {
  operationTimeoutMs?: number;
  connectTimeoutMs?: number;
  liveStepTimeoutMs?: number;
  maxWireRecordBytes?: number;
  maxWireResponseBytes?: number;
  maxEventBytes?: number;
  maxStepBytes?: number;
  maxStepEvents?: number;
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
