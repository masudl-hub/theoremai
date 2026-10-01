/**
 * OpenRouter convenience preset.
 *
 * @module
 */

/** `/images` takes image references only; a profile on it lists nothing wider in `inputs.attachments.accept`. */
const OPENROUTER_IMAGES_INPUT_MIMES = ['image/*'] as const;

export { OPENROUTER_IMAGES_INPUT_MIMES };
