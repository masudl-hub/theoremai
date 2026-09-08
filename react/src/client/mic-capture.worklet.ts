/**
 * AudioWorklet processor that forwards mono mic frames to the main thread.
 * Loaded via `audioContext.audioWorklet.addModule`.
 */
declare abstract class AudioWorkletProcessor {
	readonly port: MessagePort;
	abstract process(
		inputs: Float32Array[][],
		outputs: Float32Array[][],
		parameters: Record<string, Float32Array>,
	): boolean;
}

declare function registerProcessor(
	name: string,
	processorCtor: new () => AudioWorkletProcessor,
): void;

class MicCaptureProcessor extends AudioWorkletProcessor {
	process(inputs: Float32Array[][]): boolean {
		const channel = inputs[0][0];
		const copy = new Float32Array(channel);
		this.port.postMessage(copy, [copy.buffer]);
		return true;
	}
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
