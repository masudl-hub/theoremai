import { retryTransient } from '../shared/retry.ts';
import { bearerFetch } from '../shared/vault.ts';
import type { OpenAiGatewayTransport } from '../types.ts';

/** Every OpenRouter call: bearer key, transient backoff per key, then the fallback slot on quota. */
export function openRouterFetch(
  req: Parameters<typeof bearerFetch>[0],
  config: OpenAiGatewayTransport,
  apiKey: string,
): typeof fetch {
  return bearerFetch(req, config.fetch ?? fetch, config.vault, apiKey, (tapped) =>
    retryTransient(tapped, config.wait),
  );
}
