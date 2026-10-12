/**
 * The loader: the mark draws on the full-bleed shell, then that same panel pulls in to the shape of
 * the page it opens. The website and the studio on its own both mount this in their shell.
 */
import { useEffect, useRef, useState } from 'react';
import type { Reading } from './lib/read-progress.ts';
import { ReadMap } from './read-map.tsx';
import {
	bootHasPlayed,
	prefersReducedMotion,
	revealShell,
	type ShellShape,
	sleep,
} from './shell-motion.ts';
import { TheoremMark } from './theorem-mark.tsx';
import './boot-mark.css';

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
	 * A project being read for the page. With it, the mark moves aside once drawn and the read is
	 * drawn as a map, and the panel pulls in when the map has drawn all of it.
	 */
	reading?: Reading;
}

/**
 * The mark draws in the shell only when the page is still loading. When the dot lands, or at once
 * when the page was ready first, that same panel pulls in over the page.
 */
function useBootPhase({ shape, ready, reading }: BootMarkProps) {
	const [phase, setPhase] = useState<'draw' | 'map' | 'done'>(() => (bootHasPlayed() ? 'done' : 'draw'));
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

		/* If the page is ready before the pen starts (its delay in boot-mark.css), no mark was ever
		   on screen and the panel pulls in at once. Once the pen has started, it finishes. A page
		   that failed to load is still a page to show. */
		const loaded = Promise.resolve(latest.current.ready).catch(() => undefined);
		void Promise.all([fontsSettled(), loaded])
			.then(() => {
				if (!reduced && !penHasStarted(root)) return undefined;
				return markDrawn(root, reduced)
					.then(() => (reduced || !latest.current.reading ? undefined : map))
					.then(() => sleep(reduced ? REDUCED_HOLD_MS : HOLD_MS));
			})
			.then(reveal);

		/* A project's read is drawn as soon as the mark is, loaded or not: the map shows the read
		   while it happens. It settles when the map has drawn every step of a read that has ended. */
		const map = new Promise<void>((resolve) => {
			mapDrawn.current = resolve;
		});
		if (!reduced && latest.current.reading) {
			void markDrawn(root, reduced).then(() => {
				if (!cancelled && !revealed) setPhase('map');
			});
		}

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

	const mapped = phase === 'map' && props.reading;
	return (
		<div
			ref={rootRef}
			data-boot=""
			data-phase={phase}
			role="status"
			aria-live="polite"
			aria-label={mapped ? 'Reading your project' : 'Loading'}
		>
			<TheoremMark />
			{mapped && <ReadMap reading={mapped} onDrawn={() => mapDrawn.current()} />}
		</div>
	);
}
