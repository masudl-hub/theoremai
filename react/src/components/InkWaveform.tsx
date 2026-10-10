import { type RefObject, useEffect, useMemo, useRef } from 'react';
import {
  computeInkBarTargets,
  INK_WAVE_BAR_COUNT,
  INK_WAVE_HERO_BAR_COUNT,
  type InkWaveStatus,
  inkWaveDriver,
  inkWavePhases,
} from '../client/ink-waveform.ts';

/** Mic and speaker levels. A host on the audio clock writes this; the bars read it each frame. */
export type InkWaveLevels = { input: number; output: number };

export type InkWaveformProps = {
  status?: InkWaveStatus;
  inputLevel?: number;
  outputLevel?: number;
  /**
   * Latest levels, read each frame. When set, it wins over `inputLevel` and
   * `outputLevel`, so a host can move the bars without rendering.
   */
  levelsRef?: RefObject<InkWaveLevels>;
  toolActive?: boolean;
  frozen?: boolean;
  variant?: 'default' | 'hero' | 'pill' | 'strip';
};

type Snap = {
  status: InkWaveStatus;
  inputLevel: number;
  outputLevel: number;
  levelsRef: RefObject<InkWaveLevels> | undefined;
  toolActive: boolean;
  frozen: boolean;
};

const REST_HEIGHT = 0.06;

const WAVE_CONFIG = {
  hero: {
    viewWidth: 960,
    viewHeight: 720,
    preserveAspect: 'xMidYMax slice',
    strokeWidth: 2,
    barCount: INK_WAVE_HERO_BAR_COUNT,
  },
  pill: {
    viewWidth: 480,
    viewHeight: 120,
    preserveAspect: 'none',
    strokeWidth: 3,
    barCount: INK_WAVE_BAR_COUNT,
  },
  strip: {
    viewWidth: 1600,
    viewHeight: 48,
    preserveAspect: 'none',
    strokeWidth: 2,
    barCount: 120,
  },
  default: {
    viewWidth: 480,
    viewHeight: 320,
    preserveAspect: 'xMidYMax meet',
    strokeWidth: 2,
    barCount: INK_WAVE_BAR_COUNT,
  },
} as const;

function resolveWaveDimensions(variant: NonNullable<InkWaveformProps['variant']>) {
  const cfg = WAVE_CONFIG[variant] ?? WAVE_CONFIG.default;
  const gap = (cfg.viewWidth - cfg.strokeWidth * cfg.barCount) / (cfg.barCount + 1);
  return { ...cfg, gap };
}

/** One frame's bar targets. The live ref's levels win over the last render's; a frozen wave moves to none. */
function frameTargets(snap: Snap, phases: readonly number[], timeMs: number) {
  const { input, output } = snap.levelsRef?.current ?? {
    input: snap.inputLevel,
    output: snap.outputLevel,
  };
  const heard = snap.frozen ? { input: 0, output: 0 } : { input, output };
  return computeInkBarTargets({
    phases,
    timeMs,
    driver: inkWaveDriver(snap.status, snap.toolActive, input, output, snap.frozen),
    inputLevel: heard.input,
    outputLevel: heard.output,
    frozen: snap.frozen,
  });
}

/**
 * Paints bar heights onto the mounted lines. The motion is the same as
 * `computeInkBarTargets` plus the per-frame ease; React never sees a frame,
 * so a strip of bars does not reconcile on the audio clock.
 */
function usePaintedWave(
  svgRef: RefObject<SVGSVGElement | null>,
  snapRef: RefObject<Snap>,
  phases: readonly number[],
  barCount: number,
  viewHeight: number,
) {
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const lines = svg.children;
    const count = Math.min(barCount, lines.length);
    const heights = new Float64Array(count);
    heights.fill(REST_HEIGHT);
    const restY = viewHeight - REST_HEIGHT * (viewHeight - 4);
    for (let index = 0; index < count; index++) {
      (lines[index] as SVGLineElement).y2.baseVal.value = restY;
    }
    let frame = 0;
    const tick = (time: number) => {
      const snap = snapRef.current;
      const targets = frameTargets(snap, phases, time);
      const alpha = snap.frozen ? 0.2 : 0.14;
      for (let index = 0; index < count; index++) {
        const height = heights[index] + (targets[index] - heights[index]) * alpha;
        heights[index] = height;
        (lines[index] as SVGLineElement).y2.baseVal.value = viewHeight - height * (viewHeight - 4);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [svgRef, snapRef, phases, barCount, viewHeight]);
}

export function InkWaveform({
  status = 'disconnected',
  inputLevel = 0,
  outputLevel = 0,
  levelsRef,
  toolActive = false,
  frozen = false,
  variant = 'default',
}: InkWaveformProps) {
  const { viewWidth, viewHeight, preserveAspect, strokeWidth, barCount, gap } =
    resolveWaveDimensions(variant);
  const phases = useMemo(() => inkWavePhases(barCount), [barCount]);
  const xs = useMemo(() => {
    const next = new Array<number>(barCount);
    for (let index = 0; index < barCount; index++) {
      next[index] = gap + index * (strokeWidth + gap) + strokeWidth / 2;
    }
    return next;
  }, [barCount, gap, strokeWidth]);
  const svgRef = useRef<SVGSVGElement>(null);
  const snapRef = useRef<Snap>({
    status,
    inputLevel,
    outputLevel,
    levelsRef,
    toolActive,
    frozen,
  });
  snapRef.current.status = status;
  snapRef.current.inputLevel = inputLevel;
  snapRef.current.outputLevel = outputLevel;
  snapRef.current.levelsRef = levelsRef;
  snapRef.current.toolActive = toolActive;
  snapRef.current.frozen = frozen;
  usePaintedWave(svgRef, snapRef, phases, barCount, viewHeight);

  const className = [
    'ink-wave',
    variant === 'hero' ? 'ink-wave--hero' : '',
    variant === 'pill' ? 'ink-wave--pill' : '',
    variant === 'strip' ? 'ink-wave--strip' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const restY = viewHeight - REST_HEIGHT * (viewHeight - 4);

  return (
    <svg
      ref={svgRef}
      className={className}
      aria-hidden="true"
      viewBox={`0 0 ${String(viewWidth)} ${String(viewHeight)}`}
      preserveAspectRatio={preserveAspect}
      // why: Attribute defaults for hosts without ink-controls.css (the Astryx UI);
      // the live stylesheet overrides them where it loads.
      width="100%"
      height="100%"
    >
      {xs.map((x) => (
        <line
          // why: y2 moves every frame, outside React. Keying on the height would remount the
          // line and restart its entrance. A bar's x is its own and never moves.
          key={x}
          className="ink-wave__bar"
          x1={x}
          x2={x}
          y1={viewHeight}
          y2={restY}
          strokeWidth={strokeWidth}
          stroke="currentColor"
          strokeLinecap="square"
        />
      ))}
    </svg>
  );
}
