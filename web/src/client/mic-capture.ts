/** The processor name `worklets/mic-capture.js` registers, for `AudioWorkletNode`. */
export const MIC_CAPTURE_PROCESSOR = 'mic-capture-processor';

/** The worklet module for `audioWorklet.addModule`; bundlers ship it as an asset. */
export function micCaptureWorkletUrl(): URL {
  return new URL('./worklets/mic-capture.js', import.meta.url);
}
