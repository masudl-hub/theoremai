/**
 * OpenRouter convenience preset.
 *
 * @module
 */

/** `/images` takes image references only; a profile on it lists nothing wider in `inputs.attachments.accept`. */
const OPENROUTER_IMAGES_INPUT_MIMES = ['image/*'] as const;

/**
 * What `/images` never sends the model: it reads the prompt text and the reference images
 * only. The chat path (`image.includeText`) sends the system prompt and history.
 */
const OPENROUTER_IMAGES_IGNORED_INPUTS = ['system', 'history'] as const;

export { OPENROUTER_IMAGES_IGNORED_INPUTS, OPENROUTER_IMAGES_INPUT_MIMES };
