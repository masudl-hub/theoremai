import type { ModelId } from '../types.ts';

export function soleModelId(models: Record<ModelId, unknown>): ModelId | undefined {
  const ids = Object.keys(models);
  return ids.length === 1 ? ids[0] : undefined;
}
