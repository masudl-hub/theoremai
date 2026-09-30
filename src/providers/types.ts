import type { KeyVault } from '../kernel/types.ts';

export interface OpenAiGatewayConfig {
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
}

export interface LocalProviderConfig {
  /** e.g. `http://127.0.0.1:11434` for Ollama. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** What `createProvider` hands an adapter: the host's settings for it plus the one vault. */
export type OpenAiGatewayTransport = OpenAiGatewayConfig & { vault?: KeyVault };
export type LocalTransport = LocalProviderConfig & { vault?: KeyVault };
