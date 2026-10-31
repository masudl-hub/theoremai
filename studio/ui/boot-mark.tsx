/**
 * The loader: the mark draws on the full-bleed shell, then that same panel pulls in to the shape of
 * the page it opens. The website and the studio on its own both mount this in their shell. The
 * studio also reads a project: its panel pulls in beside the rail first and the read is drawn there
 * as it does.
 */
import { type RefObject, useEffect, useRef, useState } from 'react';
import { bootHolds, HOLD_CAP_MS } from './lib/boot-hold.ts';
import { type BootPhase, runBoot } from './lib/boot-sequence.ts';
import type { Reading } from './lib/read-progress.ts';
import { ReadMap } from './read-map.tsx';
import {
  bootHasPlayed,
  HOLD_MS as FADE_MS,
  prefersReducedMotion,
  pullShellIn,
  revealShell,
  type ShellShape,
  sleep,
} from './shell-motion.ts';
import { TheoremMark } from './theorem-mark.tsx';
import './boot-mark.css';

const DRAW_CAP_MS = 2800;
const FONT_CAP_MS = 500;

/** Resolves when the mark's dot has drawn in, at once with reduced motion, or after the cap. */
function markDrawn(root: HTMLDivElement, reduced: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    if (reduced) {
      resolve();
      return;
    }
    const dot = root.querySelector('.theorem-mark-dot');
    const cap = globalThis.setTimeout(resolve, DRAW_CAP_MS);
    const finish = () => {
      globalThis.clearTimeout(cap);
      resolve();
    };
    if (!(dot instanceof SVGCircleElement)) {
      finish();
      return;
    }
    const finished = dot.getAnimations().some((animation) => animation.playState === 'finished');
    if (finished) {
      finish();
      return;
    }
    const onEnd = (event: AnimationEvent) => {
      if (event.animationName !== 'theorem-mark-dot-in') return;
      dot.removeEventListener('animationend', onEnd);
      finish();
    };
    dot.addEventListener('animationend', onEnd);
  });
}

/** Whether the pen has begun. Until it does, the panel is blank and there is nothing to wait out. */
function penHasStarted(root: HTMLDivElement): boolean {
  const pen = root.querySelector('.theorem-mark-stroke')?.getAnimations()[0];
  const delay = pen?.effect?.getTiming().delay ?? 0;
  return Number(pen?.currentTime ?? 0) > delay;
}

/** Resolves after the page's first commit: its effects, where its screens hold the mark, have run. */
function pageCommitted(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      globalThis.setTimeout(resolve, 0);
    });
  });
}

/**
 * Holds the mark until `work` settles: a piece of the screen the page opens on, so it is there when
 * the mark gives way. Once the mark has given way, it does nothing.
 */
export function holdBoot(work: Promise<unknown>): void {
  bootHolds.hold(work);
}

/**
 * Holds the mark from the first commit until `isShown`, or for `HOLD_CAP_MS` at most, when `holds`
 * says this piece is on the screen the page opens on. `holds` is read once, at mount.
 */
export function useBootHold(isShown: boolean, holds: () => boolean): void {
  const release = useRef<() => void>(undefined);
  const decide = useRef(holds);
  useEffect(() => {
    if (bootHasPlayed() || !decide.current()) return;
    const done = bootHolds.holdUntil();
    const cap = globalThis.setTimeout(done, HOLD_CAP_MS);
    release.current = done;
    return () => {
      globalThis.clearTimeout(cap);
      done();
    };
  }, []);
  useEffect(() => {
    if (isShown) release.current?.();
  }, [isShown]);
}

/** Resolves when the fonts are ready, or after the cap. */
function fontsSettled(): Promise<void> {
  return Promise.race([document.fonts.ready.then(() => undefined), sleep(FONT_CAP_MS)]);
}

export interface BootMarkProps {
  /** The shape the shell rests in for the page on screen, read when the mark gives way. */
  shape: () => ShellShape;
  /**
   * A project being read for the page. With it, the drawn mark gives way, the panel pulls in
   * beside the rail and the read is drawn there as a map. When the map has drawn all of it, the
   * panel pulls in to the page's shape.
   */
  reading?: Reading;
}

/**
 * The mark draws in the shell only when the page is still loading. When the dot lands, or at once
 * when the page was ready first, that same panel pulls in over the page.
 */
function useBootPhase({ shape, reading }: BootMarkProps) {
  const [phase, setPhase] = useState<BootPhase>(() => (bootHasPlayed() ? 'done' : 'draw'));
  const mapDrawn = useRef<() => void>(() => {});
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ shape, reading });
  latest.current = { shape, reading };

  useEffect(() => {
    const root = rootRef.current;
    if (!root || bootHasPlayed()) return;

    const reduced = prefersReducedMotion();
    return runBoot({
      reads: !reduced && Boolean(latest.current.reading),
      reduced,
      fadeMs: FADE_MS,
      // The page is there with its fonts and everything its opening screen holds the mark for.
      settled: Promise.all([fontsSettled(), bootHolds.settled(pageCommitted())]),
      mapDrawn: new Promise<void>((resolve) => {
        mapDrawn.current = resolve;
      }),
      markDrawn: () => markDrawn(root, reduced),
      penHasStarted: () => penHasStarted(root),
      pullIn: pullShellIn,
      sleep,
      show: setPhase,
      reveal: () => {
        revealShell(latest.current.shape());
        setPhase('done');
      },
    });
  }, []);

  return { phase, rootRef, mapDrawn };
}

/** The rail beside the panel a loader draws in. */
function railOf(root: HTMLElement | null): HTMLElement | null {
  return (
    root?.closest('.astryx-app-shell')?.querySelector<HTMLElement>('.astryx-app-shell-sidenav') ??
    null
  );
}

/**
 * The rail shows beside a project's read but opens nothing until the page is there: a press or a
 * key on it would act on a page that has not loaded.
 */
function useRailHeld(rootRef: RefObject<HTMLDivElement | null>, held: boolean) {
  useEffect(() => {
    const rail = held ? railOf(rootRef.current) : null;
    if (!rail || rail.hasAttribute('inert')) return;
    rail.setAttribute('inert', '');
    return () => {
      rail.removeAttribute('inert');
    };
  }, [rootRef, held]);
}

/**
 * Draws inside the shell panel. The shell starts full-bleed; this only decides when that panel
 * pulls in over the page.
 */
export function BootMark(props: BootMarkProps) {
  const { phase, rootRef, mapDrawn } = useBootPhase(props);
  useRailHeld(rootRef, phase === 'map' || phase === 'leave');

  if (phase === 'done') return null;

  const mapped = (phase === 'map' || phase === 'leave') && props.reading;
  return (
    <div
      ref={rootRef}
      data-boot=""
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      {phase === 'draw' && <TheoremMark />}
      {/* Said once when the map starts. The map itself is not read out: it changes with every file. */}
      {mapped && <span className="boot-said">Reading your project</span>}
      {mapped && <ReadMap reading={mapped} onDrawn={() => mapDrawn.current()} />}
    </div>
  );
}
