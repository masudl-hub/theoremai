/**
 * What each provider can do, as the kernel's general rules read it. A provider's own facts live in
 * its preset; this is the one table of them.
 *
 * @module
 */

import type { Protocol, Provider } from '../kernel/schema.ts';
import { GOOGLE_FACTS } from './google-limits.ts';
import { LOCAL_FACTS } from './local.ts';
import { OPENROUTER_FACTS } from './openrouter.ts';
import { TYPESAFE_FACTS } from './typesafe.ts';

/** One provider's answers to the questions the kernel's rules ask. */
interface ProviderFacts {
  /** Whether a model here needs a key slot. One that does not never inherits the profile's key. */
  needsKey: boolean;
  /** Whether a binding names the server it calls (`models.*.server`). */
  takesServer: boolean;
  /** The protocol on which it takes `models.*.cache`; absent when it has no prompt caching. */
  cacheOn?: Protocol;
  /** The protocol on which it can store the interaction and chain from it; absent when it cannot. */
  storesOn?: Protocol;
  /** Its `gen_ai.provider.name` in a trace; absent when the binding's `server` names it. */
  traceName?: string;
  /** Where its decisions are asked for; absent when it serves none. */
  decisionsUrl?: string;
}

const PROVIDER_FACTS: Record<Provider, ProviderFacts> = {
  google: GOOGLE_FACTS,
  openrouter: OPENROUTER_FACTS,
  local: LOCAL_FACTS,
  typesafe: TYPESAFE_FACTS,
};

/** The providers a fact holds for, quoted for a config error: `'local'`, or `'a' or 'b'`. */
function providersWhere(holds: (facts: ProviderFacts) => boolean): string {
  return (Object.keys(PROVIDER_FACTS) as Provider[])
    .filter((provider) => holds(PROVIDER_FACTS[provider]))
    .map((provider) => `'${provider}'`)
    .join(' or ');
}

export type { ProviderFacts };
export { PROVIDER_FACTS, providersWhere };
