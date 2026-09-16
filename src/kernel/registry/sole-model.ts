/**
 * Shared model-id helpers for profile registration and resolution.
 *
 * @module
 */

import type { ModelBinding, ModelId } from '../types.ts';

/** When exactly one model is declared, that id is the implicit default. */
export function soleModelId(models: Record<ModelId, ModelBinding>): ModelId | undefined {
  const ids = Object.keys(models);
  return ids.length === 1 ? ids[0] : undefined;
}
