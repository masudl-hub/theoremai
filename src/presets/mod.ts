/**
 * Host-convenience catalogs for first-party providers: provider builtins and media vocabularies.
 *
 * @module
 */

export type {
  GoogleBindingViolation,
  GoogleFreeTierGrounding,
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImageOutputMime,
  GoogleImagePins,
  GoogleImageResolution,
  GoogleSpeechVoice,
  GoogleThinkingLevel,
  GoogleVoiceInputMime,
} from './google.ts';
export {
  GOOGLE_BUILTIN_TOOLS,
  GOOGLE_FREE_TIER_GROUNDING,
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_OUTPUT_MIMES,
  GOOGLE_IMAGE_RESOLUTIONS,
  GOOGLE_NO_EFFORT_API_IDS,
  GOOGLE_NO_THINKING_API_IDS,
  GOOGLE_SINGLE_TURN_API_IDS,
  GOOGLE_SPEECH_FORMATS,
  GOOGLE_SPEECH_VOICES,
  GOOGLE_THINKING_LEVELS,
  GOOGLE_THINKING_REQUIRED_API_IDS,
  GOOGLE_VOICE_INPUT_MIMES,
  googleBindingViolation,
  googleEfforts,
  googleFreeTierBuiltins,
  registerGooglePreset,
} from './google.ts';
export type { LocalBindingViolation } from './local.ts';
export { localBindingViolation, ollamaModelThinks } from './local.ts';
export {
  OPENROUTER_BUILTIN_TOOLS,
  OPENROUTER_IMAGES_IGNORED_INPUTS,
  OPENROUTER_IMAGES_INPUT_MIMES,
  registerOpenRouterPreset,
} from './openrouter.ts';
