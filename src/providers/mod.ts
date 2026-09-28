/**
 * `createProvider(profile, options)` binds a profile to a transport with host-supplied credentials.
 *
 * @module
 */

export type { KeyVault } from '../kernel/types.ts';
export type { CreateProviderOptions } from './create-provider.ts';
export { createProvider } from './create-provider.ts';
export type { GeminiTransport } from './google/keys.ts';
export type { LocalProviderConfig, OpenAiGatewayConfig } from './types.ts';
