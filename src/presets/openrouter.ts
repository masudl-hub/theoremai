/**
 * OpenRouter convenience preset.
 *
 * @module
 */

import { registerTools } from '../kernel/default-scope.ts';

/** `/images` takes image references only; a profile on it lists nothing wider in `inputs.attachments.accept`. */
const OPENROUTER_IMAGES_INPUT_MIMES = ['image/*'] as const;

/**
 * What `/images` never sends the model: it reads the prompt text and the reference images
 * only. The chat path (`image.includeText`) sends the system prompt and history.
 */
const OPENROUTER_IMAGES_IGNORED_INPUTS = ['system', 'history'] as const;

/** The tools OpenRouter runs itself, as `builtin` tool definitions. */
const OPENROUTER_BUILTIN_TOOLS = [
  {
    type: 'builtin' as const,
    name: 'webSearch',
    description: 'OpenRouter web search',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
  },
];

/** Registers into the default scope; a scope of its own takes `OPENROUTER_BUILTIN_TOOLS`. */
function registerOpenRouterPreset(): void {
  registerTools(OPENROUTER_BUILTIN_TOOLS);
}

export {
  OPENROUTER_BUILTIN_TOOLS,
  OPENROUTER_IMAGES_IGNORED_INPUTS,
  OPENROUTER_IMAGES_INPUT_MIMES,
  registerOpenRouterPreset,
};
