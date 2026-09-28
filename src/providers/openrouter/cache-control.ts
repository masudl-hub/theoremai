import type { CacheSpec } from '../../kernel/types.ts';

/** Index-signature return type: AI SDK `providerOptions` takes only plain JSON objects. */
export function cacheControlJson(spec: CacheSpec): { [key: string]: string } {
  return spec.ttl ? { type: 'ephemeral', ttl: spec.ttl } : { type: 'ephemeral' };
}
