/**
 * why: Catalog metadata must not import default-scope registration.
 * @module
 */

import type { ProviderFacts } from './facts.ts';
import { googleMediaFamily } from './google/media-tokens.ts';

const ROUTED_GOOGLE = 'google/';

export const OPENROUTER_FACTS: ProviderFacts = {
  needsKey: true,
  takesServer: false,
  cacheOn: 'openAi',
  traceName: 'openrouter',
  decisionsUrl: 'https://openrouter.ai/api/alpha/decisions',
  // why: A routed Google model uses Google's media token family.
  mediaFamily: (apiId) =>
    apiId.startsWith(ROUTED_GOOGLE)
      ? googleMediaFamily(apiId.slice(ROUTED_GOOGLE.length))
      : undefined,
};
