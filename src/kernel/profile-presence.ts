/**
 * Whether a profile must set each field, and what leaving it out does — for
 * authoring UIs, which mark the fields a profile can't omit and show what a
 * blank one means. `PROFILE_FIELDS` exposes it on each field's `FieldMeta`.
 *
 * `defineProfile` enforces the requirements; this records them for display. A
 * path with no entry says nothing either way.
 *
 * Leaf module: `schema.ts` reads it at load time.
 *
 * @module
 */

/** lexicon-exempt-file: authoring field-meta presence notes — not runtime user or model copy (P2) */

export interface ProfileFieldPresence {
  /** The profile must set the field: always (`true`), or only in the case named. */
  required?: true | string;
  /** What leaving the field out does, as a short phrase a blank control can show. */
  unset?: string;
}

/** Presence for profile paths, keyed like `PROFILE_FIELDS` (`models.*` matches every binding). */
export const PROFILE_FIELD_PRESENCE: Readonly<Record<string, ProfileFieldPresence>> = {
  id: { required: true },
  type: { required: true },
  'identity.handle': { required: true },
  'identity.system': { unset: 'No system instruction' },
  models: { required: true },
  defaultModel: { required: 'when more than one model is declared', unset: 'The only model' },
  allowModelSelect: { unset: 'Off' },
  maxSteps: { unset: 'Unbounded' },
  key: { required: 'when a Google model has no key of its own', unset: 'No key slot' },
  'models.*.protocol': { required: true },
  'models.*.provider': { required: true },
  'models.*.apiId': { required: true },
  'models.*.builtInTools': { unset: 'None' },
  'models.*.maxOutputTokens': { unset: 'Provider default' },
  'models.*.temperature': { unset: 'Provider default' },
  'models.*.summaries': { unset: 'Provider default' },
  'models.*.efforts': { unset: 'Provider default' },
  'models.*.defaultEffort': {
    required: 'when more than one effort is declared',
    unset: 'The only effort',
  },
  'models.*.allowEffortSelect': { unset: 'Off' },
  'inputs.text': { unset: 'Accepted' },
  'inputs.attachments.accept': { unset: 'No attachments' },
  'inputs.voice.accept': { unset: 'No voice' },
  'inputs.maxFiles': { required: 'when attachments or voice is set' },
  'inputs.maxBytes': { required: 'when attachments or voice is set' },
  'inputs.maxTurnBytes': { required: 'when attachments or voice is set' },
  'image.aspectRatio': { unset: 'Provider default' },
  'image.size': { unset: 'Provider default' },
  'image.mimeType': { unset: 'Provider default' },
  'image.maxInputImages': { unset: 'No image cap' },
  'image.includeText': { unset: 'Off' },
  'speech.voice': { unset: 'Provider default' },
  'speech.format': { unset: 'pcm' },
  'live.ingress.audio': { unset: 'On' },
  'live.ingress.video': { unset: 'On' },
  'live.ingress.text': { unset: 'Off' },
  'live.voice': { unset: 'Provider default' },
  'live.vad.activityHandling': { unset: 'Provider default' },
  'live.vad.startSensitivity': { unset: 'Provider default' },
  'live.vad.endSensitivity': { unset: 'Provider default' },
  'live.vad.prefixPaddingMs': { unset: 'Provider default' },
  'live.vad.silenceDurationMs': { unset: 'Provider default' },
  'live.sessionResumption': { unset: 'Off' },
  'live.contextCompression': { unset: 'Off' },
  'live.contextCompression.triggerTokens': { unset: 'Provider default' },
  'live.contextCompression.slidingWindow': { required: true },
  'live.contextCompression.slidingWindow.targetTokens': { unset: 'Provider default' },
  'live.proactiveAudio': { unset: 'Off' },
  'live.transcription.input': { unset: 'Off' },
  'live.transcription.output': { unset: 'Off' },
};
