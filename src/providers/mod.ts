/**
 * Protocols, providers, and what it takes to define either: a protocol owns the wire, a provider is
 * where a service is and how to sign in to it.
 * @module
 */

export type {
  ProviderCheckpoint,
  ProviderContinuationPolicy,
  ProviderWarning,
} from '../kernel/checkpoint.ts';
export type { JsonObject, JsonValue } from '../kernel/json.ts';
export { jsonObjectSchema, jsonValueSchema } from '../kernel/json.ts';
export type { DecisionModelBinding, ModelBinding } from '../kernel/protocols/binding.ts';
export type { ProviderLimits } from '../kernel/protocols/limits.ts';
export type { ModelPrice, PriceTable, Rates } from '../kernel/protocols/prices.ts';
export type {
  Continuation,
  DecisionCall,
  EmbeddingCall,
  EmbeddingMediaKind,
  EmbeddingModelLimits,
  ExtensionBodyAt,
  ExtensionReader,
  LiveToolResult,
  ModelProfileType,
  Protocol,
  ProtocolContentEvent,
  ProtocolContext,
  ProtocolDefinition,
  ProtocolEvent,
  ProtocolExtension,
  ProtocolOperations,
  ProtocolRequest,
  ProtocolSession,
  ProtocolSocket,
  SendInit,
  UpstreamFailure,
} from '../kernel/protocols/protocol.ts';
export {
  carriesTo,
  defineProtocol,
  extendProtocol,
  modelOptions,
} from '../kernel/protocols/protocol.ts';
export type {
  Authorize,
  Outgoing,
  Provider,
  ProviderDefinition,
  ProviderRegistry,
  RegisteredProvider,
  Registration,
  Serve,
  Signer,
} from '../kernel/protocols/provider.ts';
export {
  bearer,
  createProviderRegistry,
  defineProvider,
  endpointUrlSchema,
  header,
  query,
} from '../kernel/protocols/provider.ts';
export type { OpenWebSocket, ProviderHostOptions } from '../kernel/protocols/runtime.ts';
export type {
  CredentialContext,
  CredentialResolver,
  KeyCredential,
  KeyVault,
} from '../kernel/registry/vault.ts';
export { embeddingModelLimits } from './embedding-limits.ts';
export { geminiEmbeddings } from './gemini/embeddings-protocol.ts';
export { geminiInteractions } from './gemini/interactions-protocol.ts';
export { geminiLive } from './gemini/live-protocol.ts';
export { geminiProvider } from './gemini/provider.ts';
export { ollamaEmbeddings } from './local/embeddings-protocol.ts';
export { localProvider } from './local/provider.ts';
export { openAi } from './open-ai/protocol.ts';
export { openRouterDecisions } from './openrouter/decisions-protocol.ts';
export { openRouterEmbeddings } from './openrouter/embeddings-protocol.ts';
export { openRouterImages } from './openrouter/images-protocol.ts';
export { openRouterOpenAi } from './openrouter/protocol.ts';
export { openRouterProvider } from './openrouter/provider.ts';
export { systemOne } from './system-one/protocol.ts';
export { typesafeProvider } from './typesafe/provider.ts';
