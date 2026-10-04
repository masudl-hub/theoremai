import type { KeyVault } from '../kernel/types.ts';
import type { Wait } from './shared/retry.ts';

/** Settings for the OpenAI-compatible gateway provider: its base URL, the site URL and name sent as `HTTP-Referer` and `X-Title`, and the fetch and wait to use. */
export interface OpenAiGatewayConfig {
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
  wait?: Wait;
}

/** Settings for a local OpenAI-compatible server: its base URL and an optional fetch. */
export interface LocalProviderConfig {
  /** e.g. `http://127.0.0.1:11434` for Ollama. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** What `createProvider` hands an adapter: the host's settings for it plus the one vault. */
export type OpenAiGatewayTransport = OpenAiGatewayConfig & { vault?: KeyVault };
export type LocalTransport = LocalProviderConfig & { vault?: KeyVault };
