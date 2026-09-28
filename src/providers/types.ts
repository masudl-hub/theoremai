import type { KeyVault } from '../kernel/types.ts';

export interface OpenAiGatewayConfig {
  /** Read as `vault[keySlot]` when the turn has a `keySlot`. */
  vault?: KeyVault;
  /** Used only when the turn has no `keySlot`; ignored otherwise (the vault is required then). */
  apiKey?: string;
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
