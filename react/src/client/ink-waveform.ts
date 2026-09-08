export const INK_WAVE_BAR_COUNT = 21;
export const INK_WAVE_HERO_BAR_COUNT = 45;

const LEVEL_FLOOR = 0.02;

/** Per-bar phase offsets — stable undulation, not a fixed bell curve. */
export function inkWavePhases(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i * 0.73 + Math.sin(i * 1.17) * 0.4);
}

export type InkWaveStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'ready'
	| 'listening'
	| 'speaking'
	| 'error';

export type InkWaveDriver = 'idle' | 'input' | 'output' | 'tool' | 'connecting';

export function inkWaveDriver(
	status: InkWaveStatus,
	toolActive: boolean,
	inputLevel: number,
	outputLevel: number,
	frozen = false,
): InkWaveDriver {
	if (frozen) return 'idle';
	if (status === 'disconnected' || status === 'error') return 'idle';
	if (status === 'connecting') return 'connecting';
	if (toolActive) return 'tool';
	if (status === 'speaking' || outputLevel > LEVEL_FLOOR) return 'output';
	if (inputLevel > LEVEL_FLOOR) return 'input';
	if (status === 'listening' || status === 'ready') return 'idle';
	return 'idle';
}

export function computeInkBarTargets(args: {
	phases: readonly number[];
	timeMs: number;
	driver: InkWaveDriver;
	inputLevel: number;
	outputLevel: number;
	frozen?: boolean;
}): number[] {
	const t = args.timeMs * 0.001;
	if (args.frozen) {
		return args.phases.map((phase, index) => {
			const silhouette = 0.22 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 1.7 + index * 0.41));
			return Math.min(0.82, Math.max(0.1, silhouette));
		});
	}

	const input = args.inputLevel;
	const output = args.outputLevel;
	let master: number;

	switch (args.driver) {
		case 'output':
			master = 0.18 + output * 0.95;
			break;
		case 'input':
			master = 0.16 + input * 0.96;
			break;
		case 'tool':
			master = 0.28 + 0.18 * Math.sin(t * 5.2) + Math.max(output, input) * 0.45;
			break;
		case 'connecting':
			master = 0.14 + 0.1 * Math.sin(t * 3.1);
			break;
		default:
			master = 0.08 + 0.04 * Math.sin(t * 1.4);
			break;
	}

	return args.phases.map((phase, index) => {
		const wobble = 0.72 + 0.28 * Math.sin(t * 3.4 + phase);
		const ripple = 0.68 + 0.32 * Math.sin(t * 5.3 + index * 0.62);
		const height = master * wobble * ripple;
		return Math.min(1, Math.max(0.06, height));
	});
}

/** Smooth toward targets each animation frame (orchid ease feel). */
export function stepInkBarHeights(current: number[], targets: number[], alpha = 0.14): number[] {
	return current.map((value, index) => value + (targets[index] - value) * alpha);
}
