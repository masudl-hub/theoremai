/**
 * Shared host `onStage` invocation for text runner and live session.
 *
 * @module
 */

import { throwIfAborted } from '../../guardrails/error.ts';
import type { StageContext, StageHandler, StageResult } from '../stages.ts';

/** Await a host stage handler with abort-safe catch/rethrow. */
export async function invokeStageHandler(
  onStage: StageHandler,
  ctx: StageContext,
  signal?: AbortSignal,
): Promise<StageResult | undefined> {
  let raw: StageResult | undefined;
  try {
    raw = (await onStage(ctx)) ?? undefined;
  } catch (err) {
    throwIfAborted(signal);
    throw err;
  }
  throwIfAborted(signal);
  return raw;
}
