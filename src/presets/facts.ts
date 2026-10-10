/**
 * First-party catalog facts used by presets and the studio. Registered adapters
 * validate runtime support independently of this catalog.
 *
 * @module
 */

import type { MediaTokenFamily } from '../kernel/engine/token-estimate.ts';
import type { Protocol, Provider } from '../kernel/schema.ts';
import { GOOGLE_FACTS } from './google-limits.ts';
import { LOCAL_FACTS } from './local.ts';
import { OPENROUTER_FACTS } from './openrouter.ts';
import { TYPESAFE_FACTS } from './typesafe.ts';

/** First-party catalog metadata for profile editors and usage estimates. */
interface ProviderFacts {
  /** Whether the catalog asks the builder to choose a credential slot. */
  needsKey: boolean;
  /** Whether a binding names the server it calls (`models.*.providerOptions.server`). */
  takesServer: boolean;
  /** The protocol on which it takes `models.*.providerOptions.cache`; absent when it has no prompt caching. */
  cacheOn?: Protocol;
  /** The protocol on which it can store the interaction and chain from it; absent when it cannot. */
  storesOn?: Protocol;
  /** A catalog display name; runtime traces use the registered provider ID. */
  traceName?: string;
  /** Where its decisions are asked for; absent when it serves none. */
  decisionsUrl?: string;
  /** The media family of one of its model ids, for estimating tokens; absent when none is measured. */
  mediaFamily?: (apiId: string) => MediaTokenFamily | undefined;
}

const PROVIDER_FACTS: Record<Provider, ProviderFacts> = {
  google: GOOGLE_FACTS,
  openrouter: OPENROUTER_FACTS,
  local: LOCAL_FACTS,
  typesafe: TYPESAFE_FACTS,
};

export type { ProviderFacts };
export { PROVIDER_FACTS };
