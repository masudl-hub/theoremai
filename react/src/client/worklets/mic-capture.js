/**
 * AudioWorklet processor that forwards mono mic frames to the main thread.
 * Plain JS: it runs in the AudioWorkletGlobalScope as its own module, loaded
 * by URL (see `../mic-capture.ts`), so it imports nothing and ships as is.
 */
registerProcessor(
	'mic-capture-processor',
	class MicCaptureProcessor extends AudioWorkletProcessor {
		process(inputs) {
			const channel = inputs[0][0];
			const copy = new Float32Array(channel);
			this.port.postMessage(copy, [copy.buffer]);
			return true;
		}
	},
);
