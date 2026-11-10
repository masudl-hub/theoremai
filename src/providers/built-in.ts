import { geminiProvider } from './gemini/provider.ts';
import { localProvider } from './local/provider.ts';
import { openRouterProvider } from './openrouter/provider.ts';
import { typesafeProvider } from './typesafe/provider.ts';

/** The providers this package ships, for code that lists or labels them without naming one. */
export const BUILT_IN_PROVIDERS = [
  geminiProvider,
  localProvider,
  openRouterProvider,
  typesafeProvider,
] as const;
