import type { ProviderFacts } from './facts.ts';

/** TypeSafe's Jev input price; output tokens are free (28 September 2026). */
export const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

/** What TypeSafe can do, as the kernel's rules read it. */
export const TYPESAFE_FACTS: ProviderFacts = {
  needsKey: true,
  takesServer: false,
  decisionsUrl: 'https://api.typesafe.ai/v1/systemone',
};
