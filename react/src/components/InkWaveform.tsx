import { useEffect, useMemo, useRef, useState } from 'react';
import {
	computeInkBarTargets,
	INK_WAVE_BAR_COUNT,
	INK_WAVE_HERO_BAR_COUNT,
	type InkWaveStatus,
	inkWaveDriver,
	inkWavePhases,
	stepInkBarHeights,
} from '../client/ink-waveform';

export type InkWaveformProps = {
	status?: InkWaveStatus;
	inputLevel?: number;
	outputLevel?: number;
	toolActive?: boolean;
	frozen?: boolean;
	variant?: 'default' | 'hero' | 'pill';
};

type Snap = {
	status: InkWaveStatus;
	inputLevel: number;
	outputLevel: number;
	toolActive: boolean;
	frozen: boolean;
};

export function InkWaveform({
	status = 'disconnected',
	inputLevel = 0,
	outputLevel = 0,
	toolActive = false,
	frozen = false,
	variant = 'default',
}: InkWaveformProps) {
	const viewWidth = variant === 'hero' ? 960 : 480;
	const viewHeight = variant === 'hero' ? 720 : variant === 'pill' ? 120 : 320;
	const preserveAspect =
		variant === 'hero' ? 'xMidYMax slice' : variant === 'pill' ? 'none' : 'xMidYMax meet';
	const strokeWidth = variant === 'pill' ? 3 : 2;
	const barCount = variant === 'hero' ? INK_WAVE_HERO_BAR_COUNT : INK_WAVE_BAR_COUNT;
	const gap = (viewWidth - strokeWidth * barCount) / (barCount + 1);
	const phases = useMemo(() => inkWavePhases(barCount), [barCount]);

	const [heights, setHeights] = useState<number[]>(() =>
		Array.from({ length: barCount }, () => 0.06),
	);

	const snapRef = useRef<Snap>({
		status,
		inputLevel,
		outputLevel,
		toolActive,
		frozen,
	});

	useEffect(() => {
		snapRef.current = { status, inputLevel, outputLevel, toolActive, frozen };
	}, [status, inputLevel, outputLevel, toolActive, frozen]);

	useEffect(() => {
		let frame = 0;
		setHeights(Array.from({ length: barCount }, () => 0.06));
		const tick = (time: number) => {
			const snap = snapRef.current;
			setHeights((prev) => {
				const current =
					prev.length === barCount ? prev : Array.from({ length: barCount }, () => 0.06);
				const targets = computeInkBarTargets({
					phases,
					timeMs: time,
					driver: inkWaveDriver(
						snap.status,
						snap.toolActive,
						snap.inputLevel,
						snap.outputLevel,
						snap.frozen,
					),
					inputLevel: snap.frozen ? 0 : snap.inputLevel,
					outputLevel: snap.frozen ? 0 : snap.outputLevel,
					frozen: snap.frozen,
				});
				return stepInkBarHeights(current, targets, snap.frozen ? 0.2 : 0.14);
			});
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
		};
	}, [barCount, phases]);

	const bars = heights.map((height, index) => {
		const x = gap + index * (strokeWidth + gap) + strokeWidth / 2;
		const barHeight = height * (viewHeight - 4);
		return { x, y2: viewHeight - barHeight };
	});

	const className = [
		'ink-wave',
		variant === 'hero' ? 'ink-wave--hero' : '',
		variant === 'pill' ? 'ink-wave--pill' : '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<svg
			className={className}
			aria-hidden="true"
			viewBox={`0 0 ${String(viewWidth)} ${String(viewHeight)}`}
			preserveAspectRatio={preserveAspect}
		>
			{bars.map((bar) => (
				<line
					key={`${String(bar.x)}:${String(bar.y2)}`}
					className="ink-wave__bar"
					x1={bar.x}
					x2={bar.x}
					y1={viewHeight}
					y2={bar.y2}
					strokeWidth={strokeWidth}
				/>
			))}
		</svg>
	);
}
