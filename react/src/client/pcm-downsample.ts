/** Resample Float32 audio buffer from inputRate to outputRate and convert to Int16 PCM. */
export function downsampleAndConvertToInt16(
	inputData: Float32Array,
	inputRate: number,
	outputRate = 16000,
): Int16Array {
	if (inputRate === outputRate) {
		return float32ToInt16(inputData);
	}

	const ratio = inputRate / outputRate;
	const newLength = Math.round(inputData.length / ratio);
	const result = new Int16Array(newLength);
	let offsetResult = 0;
	let offsetInput = 0;

	while (offsetResult < result.length) {
		const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
		let accum = 0;
		let count = 0;
		for (let i = offsetInput; i < nextOffsetInput && i < inputData.length; i++) {
			accum += inputData[i] ?? 0;
			count++;
		}
		result[offsetResult] = floatSampleToInt16(count > 0 ? accum / count : 0);
		offsetResult++;
		offsetInput = nextOffsetInput;
	}
	return result;
}

function float32ToInt16(inputData: Float32Array): Int16Array {
	const result = new Int16Array(inputData.length);
	for (let i = 0; i < inputData.length; i++) {
		result[i] = floatSampleToInt16(inputData[i] ?? 0);
	}
	return result;
}

function floatSampleToInt16(val: number): number {
	const s = Math.max(-1, Math.min(1, val));
	return s < 0 ? s * 0x8000 : s * 0x7fff;
}

/** Decode little-endian PCM16 bytes to Float32 samples in [-1, 1]. */
export function pcm16BytesToFloat32(bytes: Uint8Array<ArrayBufferLike>): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const float32 = new Float32Array(bytes.byteLength / 2);
	for (let i = 0; i < float32.length; i++) {
		const sample = view.getInt16(i * 2, true);
		float32[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
	}
	return float32;
}
