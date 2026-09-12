/**
 * Shared OpenRouter `cache_control` directive from a profile CacheSpec.
 *
 * Used by AI SDK `providerOptionsFor` and REST `toOpenAiChatPayload` so both
 * paths share one wire shape.
 *
 * @module
 */

import type { CacheTtl } from '../../kernel/schema.ts';
import type { CacheSpec } from '../../kernel/types.ts';

/** Anthropic / OpenRouter ephemeral cache_control object. */
export interface CacheControlDirective {
  type: 'ephemeral';
  ttl?: CacheTtl;
}

/** Map a profile CacheSpec to the upstream cache_control body fragment. */
export function cacheControlFromSpec(spec: CacheSpec): CacheControlDirective {
  if (spec.ttl) {
    return { type: 'ephemeral', ttl: spec.ttl };
  }
  return { type: 'ephemeral' };
}

/**
 * Plain JSON object for AI SDK `providerOptions` (needs string index signature).
 * Same values as `cacheControlFromSpec`.
 */
export function cacheControlJson(spec: CacheSpec): { [key: string]: string } {
  const directive = cacheControlFromSpec(spec);
  return directive.ttl ? { type: directive.type, ttl: directive.ttl } : { type: directive.type };
}
