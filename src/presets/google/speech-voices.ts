/**
 * Google Gemini TTS voice names for `speech.voice`.
 *
 * Standalone preset vocabulary — no kernel registry imports so docs UIs can
 * import this file without pulling provider wiring.
 *
 * @module
 */

/** Common Gemini TTS voice names. */
export const GOOGLE_SPEECH_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

/** Voice identifier accepted by the Google speech preset. */
export type GoogleSpeechVoice = (typeof GOOGLE_SPEECH_VOICES)[number];
