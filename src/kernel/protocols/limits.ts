import { z } from 'zod';

/** The budgets every provider call runs under; a host may tighten or loosen each. */
export interface ProviderLimits {
  operationTimeoutMs: number;
  connectTimeoutMs: number;
  liveStepTimeoutMs: number;
  maxWireRecordBytes: number;
  maxWireResponseBytes: number;
  maxEventBytes: number;
  maxStepBytes: number;
  maxStepEvents: number;
  maxPendingToolCalls: number;
}

const positiveBudget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timerBudget = positiveBudget.max(2147483647);
export const providerLimitsSchema: z.ZodType<ProviderLimits> = z.strictObject({
  operationTimeoutMs: timerBudget,
  connectTimeoutMs: timerBudget,
  liveStepTimeoutMs: timerBudget,
  maxWireRecordBytes: positiveBudget,
  maxWireResponseBytes: positiveBudget,
  maxEventBytes: positiveBudget,
  maxStepBytes: positiveBudget,
  maxStepEvents: positiveBudget,
  maxPendingToolCalls: positiveBudget,
});

export function resolveProviderLimits(overrides: Partial<ProviderLimits> = {}): ProviderLimits {
  return Object.freeze(
    providerLimitsSchema.parse({
      operationTimeoutMs: 120000,
      connectTimeoutMs: 30000,
      liveStepTimeoutMs: 120000,
      maxWireRecordBytes: 16 * 1024 * 1024,
      maxWireResponseBytes: 64 * 1024 * 1024,
      maxEventBytes: 16 * 1024 * 1024,
      maxStepBytes: 64 * 1024 * 1024,
      maxStepEvents: 100000,
      maxPendingToolCalls: 32,
      ...overrides,
    }),
  );
}
