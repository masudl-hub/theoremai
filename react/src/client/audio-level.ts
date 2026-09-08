/** Shared mic RMS → waveform level scaling for live and turn-composer paths. */
export const INPUT_LEVEL_GAIN = 4;

export function float32Rms(samples: Float32Array): number {
	let sum = 0;
	for (const sample of samples) {
		sum += sample * sample;
	}
	if (samples.length === 0) return 0;
	return Math.sqrt(sum / samples.length);
}

export function float32RmsToLevel(samples: Float32Array): number {
	return Math.min(1, float32Rms(samples) * INPUT_LEVEL_GAIN);
}

export function timeDomainBytesToLevel(samples: Uint8Array): number {
	let sum = 0;
	for (const sample of samples) {
		const normalized = (sample - 128) / 128;
		sum += normalized * normalized;
	}
	if (samples.length === 0) return 0;
	return Math.min(1, Math.sqrt(sum / samples.length) * INPUT_LEVEL_GAIN);
}
