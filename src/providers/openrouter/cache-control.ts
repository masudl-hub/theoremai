/**
 * OpenRouter `cache_control` directive from a profile CacheSpec, as a plain
 * JSON object for AI SDK `providerOptions` (needs a string index signature).
 *
 * @module
 */

import type { CacheSpec } from '../../kernel/types.ts';

/** Map a profile CacheSpec to the upstream ephemeral `cache_control` fragment. */
export function cacheControlJson(spec: CacheSpec): { [key: string]: string } {
  return spec.ttl ? { type: 'ephemeral', ttl: spec.ttl } : { type: 'ephemeral' };
}
