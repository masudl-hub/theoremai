/**
 * The providers a workspace's models are served by, and what each one's
 * adapter takes. A model names its provider; the provider's adapter decides
 * which kinds of agent it serves and what a model on it can do, as it does
 * for the kernel.
 *
 * @module
 */

import type { ProviderAdapter, ProviderCapabilities } from '../src/kernel/provider-contract.ts';
import {
  googleAdapter,
  openAIChat,
  openRouterAdapter,
  typesafeAdapter,
} from '../src/providers/adapters.ts';

/** One provider the workspace's models can name. */
export interface StudioProvider {
  /** What a model's `provider` says. */
  id: string;
  /** The id of the adapter it is defined with: `google`, `openrouter`, `openai-chat`, `typesafe`, or a project's own. */
  adapter: string;
  /**
   * What it connects with. Left out for an adapter that is the project's own: what that one
   * connects with stays with the project.
   */
  connection?: Record<string, string>;
  /** The slot its models read their key from, unless a model names its own. */
  keySlot?: string;
  /** The slot they read when the first one's key is refused. */
  fallbackKeySlot?: string;
}

/** The provider the studio reaches on the builder's own machine. */
export const LOCAL_PROVIDER_ID = 'local';

/** The providers the studio defines itself, for a workspace no project defines them for. */
export const STUDIO_PROVIDERS: readonly StudioProvider[] = [
  { id: 'google', adapter: 'google' },
  { id: 'openrouter', adapter: 'openrouter' },
  {
    id: LOCAL_PROVIDER_ID,
    adapter: 'openai-chat',
    connection: { baseURL: 'http://localhost:11434/v1' },
  },
  { id: 'typesafe', adapter: 'typesafe' },
];

/** The kinds of agent an adapter can be asked about. */
export type ServedProfileType = ProviderCapabilities['profileTypes'][number];

/** What an adapter says the model `apiId` can do, asked with nothing set on the provider or the model. */
type Asked = (apiId: string) => ProviderCapabilities;

function asked<C, O, K, S>(adapter: ProviderAdapter<C, O, K, S>): Asked {
  return (apiId) => adapter.capabilities({ apiId, connection: {} as C, providerOptions: {} as O });
}

// why: an adapter is made once; each answer is its own.
const ADAPTERS: Record<string, { asked: Asked; factory: string }> = {
  google: { asked: asked(googleAdapter()), factory: 'googleAdapter' },
  openrouter: { asked: asked(openRouterAdapter()), factory: 'openRouterAdapter' },
  'openai-chat': { asked: asked(openAIChat()), factory: 'openAIChat' },
  typesafe: { asked: asked(typesafeAdapter()), factory: 'typesafeAdapter' },
};

/** The kernel export that makes the adapter, for code the studio writes. Undefined for a project's own adapter. */
export function adapterFactory(adapter: string): string | undefined {
  return ADAPTERS[adapter]?.factory;
}

/** The adapter the provider `id` is defined with, among `providers`. */
export function adapterOf(providers: readonly StudioProvider[], id: string): string | undefined {
  return providers.find((provider) => provider.id === id)?.adapter;
}

/**
 * What the adapter says the model `apiId` can do. Undefined for an adapter the studio does not
 * hold, a project's own: the studio then judges nothing about its models.
 */
export function modelCapabilities(adapter: string | undefined, apiId: string): ProviderCapabilities | undefined {
  return adapter === undefined ? undefined : ADAPTERS[adapter]?.asked(apiId.trim());
}

/**
 * Whether the adapter serves agents of `type` with the model `apiId`, or with some model when
 * `apiId` is left out. An adapter the studio does not hold is taken to.
 */
export function servesProfileType(adapter: string | undefined, type: ServedProfileType, apiId = ''): boolean {
  const capabilities = modelCapabilities(adapter, apiId);
  return capabilities === undefined || capabilities.profileTypes.includes(type);
}

/** A model as the studio's rules read it: its provider, that provider's adapter, and whether it decides. */
export interface ModelRoute {
  provider: string;
  adapter: string | undefined;
  apiId: string;
  /** The model is a decision agent's. */
  decision: boolean;
}

/** The route of `binding`, a model of an agent of `type` whose providers are `providers`. */
export function modelRoute(
  providers: readonly StudioProvider[],
  type: string,
  binding: { provider: string; apiId: string },
): ModelRoute {
  return {
    provider: binding.provider,
    adapter: adapterOf(providers, binding.provider),
    apiId: binding.apiId,
    decision: type === 'decision',
  };
}
