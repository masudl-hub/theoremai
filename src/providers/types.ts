import type { KeyVault } from '../kernel/types.ts';

/** OpenAI-gateway credentials for `openAi` profiles (OpenRouter or compatible). */
export interface OpenAiGatewayConfig {
  /**
   * Multi-slot credential vault (same `KEY_SLOTS` shape as Google).
   * When `keySlot` is set on the turn, the adapter reads `vault[keySlot]`.
   */
  vault?: KeyVault;
  /**
   * Single-key fallback when the profile does not pin `model.key` / `keySlot`.
   * Ignored when `keySlot` is set (vault is required then).
   */
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
}

/** Host-supplied config for the local OpenAI-compat provider. */
export interface LocalProviderConfig {
  /**
   * Base URL of the OpenAI-compat server (no trailing slash).
   * Defaults to `http://127.0.0.1:11434`.
   */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}
