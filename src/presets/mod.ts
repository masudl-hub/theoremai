/**
 * Optional host-convenience catalogs (provider builtins, media vocabularies) kept out of the kernel.
 *
 * @module
 */

export type {
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImagePins,
  GoogleImageSize,
  GoogleInteractionsPersistence,
  GoogleSpeechVoice,
  GoogleVoiceInputMime,
} from './google.ts';
export {
  GOOGLE_BUILTIN_TOOLS,
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_SIZES,
  GOOGLE_NO_THINKING_API_IDS,
  GOOGLE_SINGLE_TURN_API_IDS,
  GOOGLE_SPEECH_FORMATS,
  GOOGLE_SPEECH_VOICES,
  GOOGLE_THINKING_LEVELS,
  GOOGLE_VOICE_INPUT_MIMES,
  googleInteractionsPersistence,
  registerGooglePreset,
} from './google.ts';
export { OPENROUTER_IMAGES_IGNORED_INPUTS, OPENROUTER_IMAGES_INPUT_MIMES } from './openrouter.ts';
export { JEV_USD_PER_MILLION_INPUT_TOKENS } from './typesafe.ts';
