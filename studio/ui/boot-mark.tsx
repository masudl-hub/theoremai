/**
 * The loader: the mark draws on the full-bleed shell, then that same panel pulls in to the shape of
 * the page it opens. The website and the studio on its own both mount this in their shell. The
 * studio also reads a project: its panel pulls in beside the rail first and the read is drawn there.
 */
import { useEffect, useRef, useState } from 'react';
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

/**
 * What the loader shows: the mark drawing, the panel pulling in for a project's read, the map of
 * that read, the map fading out, and nothing once the page has the shell.
 */
type BootPhase = 'draw' | 'pull' | 'map' | 'leave' | 'done';

const DRAW_CAP_MS = 2800;
const HOLD_MS = 90;
const REDUCED_HOLD_MS = 200;
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

/** Resolves when the fonts are ready, or after the cap. */
function fontsSettled(): Promise<void> {
	return Promise.race([document.fonts.ready.then(() => undefined), sleep(FONT_CAP_MS)]);
}

export interface BootMarkProps {
	/** The shape the shell rests in for the page on screen, read when the mark gives way. */
	shape: () => ShellShape;
	/** Settles when the page under the mark is on screen. Left out, the page is ready with its fonts. */
	ready?: Promise<unknown>;
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
function useBootPhase({ shape, ready, reading }: BootMarkProps) {
	const [phase, setPhase] = useState<BootPhase>(() => (bootHasPlayed() ? 'done' : 'draw'));
	const mapDrawn = useRef<() => void>(() => {});
	const rootRef = useRef<HTMLDivElement>(null);
	const latest = useRef({ shape, ready, reading });
	latest.current = { shape, ready, reading };

	useEffect(() => {
		const root = rootRef.current;
		if (!root || bootHasPlayed()) return;

		const reduced = prefersReducedMotion();
		let cancelled = false;
		let revealed = false;

		const reveal = () => {
			if (cancelled || revealed) return;
			revealed = true;
			revealShell(latest.current.shape());
			setPhase('done');
		};

		/* A project's read is drawn once the mark is, loaded or not. The mark gives way as it does
		   for any page, the panel pulls in beside the rail, and the map draws on it. `map` settles
		   when the map has drawn every step of a read that has ended. */
		const map = new Promise<void>((resolve) => {
			mapDrawn.current = resolve;
		});
		const reads = !reduced && Boolean(latest.current.reading);
		let pulling = false;
		const mapped = reads
			? markDrawn(root, reduced)
					.then(() => sleep(HOLD_MS))
					.then(() => {
						if (cancelled || revealed) return false;
						pulling = true;
						setPhase('pull');
						return pullShellIn().then(() => {
							if (cancelled) return false;
							setPhase('map');
							return true;
						});
					})
			: Promise.resolve(false);

		/* If the page is ready before the pen starts (its delay in boot-mark.css), no mark was ever
		   on screen and the panel pulls in at once. Once the pen has started, it finishes, and so
		   does a map. A page that failed to load is still a page to show. */
		const loaded = Promise.resolve(latest.current.ready).catch(() => undefined);
		void Promise.all([fontsSettled(), loaded])
			.then(() => {
				if (!reduced && !pulling && !penHasStarted(root)) return undefined;
				if (!reads) return markDrawn(root, reduced).then(() => sleep(reduced ? REDUCED_HOLD_MS : HOLD_MS));
				return mapped.then((shown) => {
					if (!shown || cancelled) return undefined;
					return map.then(() => {
						if (cancelled) return undefined;
						setPhase('leave');
						return sleep(FADE_MS);
					});
				});
			})
			.then(reveal);

		return () => {
			cancelled = true;
		};
	}, []);

	return { phase, rootRef, mapDrawn };
}

/**
 * Draws inside the shell panel. The shell starts full-bleed; this only decides when that panel
 * pulls in over the page.
 */
export function BootMark(props: BootMarkProps) {
	const { phase, rootRef, mapDrawn } = useBootPhase(props);

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
