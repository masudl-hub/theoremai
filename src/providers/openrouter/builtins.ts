/**
 * The tools OpenRouter runs itself. None takes args from a request yet.
 *
 * @module
 */

import type { ProviderBuiltinSpec } from '../../kernel/provider-contract.ts';

/** `webSearch` is sent as `web_search_options`. */
const OPENROUTER_BUILTINS = {
  webSearch: {},
} satisfies Record<string, ProviderBuiltinSpec>;

export { OPENROUTER_BUILTINS };
