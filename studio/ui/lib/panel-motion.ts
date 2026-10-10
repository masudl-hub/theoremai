/**
 * The panel takes the whole frame for the map, and gives it back. The tree and the editor stay
 * where they are, at the widths they had; the preview and the panel's handle fade out, the panel's
 * far edge moves over them the way the shell's does after load, uncovering the map, and back.
 */
import { HOLD_MS, prefersReducedMotion, sleep } from '../shell-motion.ts';

/** Keep in step with the shell's own move and fade in shell-motion.css. */
const MOVE_MS = 640;
const FADE_MS = 280;
const EASE = 'cubic-bezier(0.45, 0.02, 0.15, 1)';

/** What fades around the move: the preview and the panel's handle. */
const PARTS = '.studio-preview, .studio-side-handle';

/** A phone's panel already takes the frame, and reduced motion moves nothing. */
export function panelCanMove(): boolean {
	return globalThis.matchMedia('(min-width: 768px)').matches && !prefersReducedMotion();
}

/** A tab in the background runs no animation, so each one is also given its time and no longer. */
function ended(animations: Animation[], ms: number): Promise<unknown> {
	const all = Promise.all(animations.map((each) => each.finished.catch(() => undefined)));
	return Promise.race([all, sleep(ms + 200)]);
}

/**
 * Move the panel around `swap`, which puts the next view on screen and must have drawn it by the
 * time it returns. `widens` is the map opening; otherwise it is closing. Without a panel to move,
 * the swap happens at once.
 */
export async function movePanel(widens: boolean, swap: () => void): Promise<void> {
	const frame = document.querySelector<HTMLElement>('.studio-frame');
	const surface = frame?.querySelector<HTMLElement>('[data-shell-frame]');
	if (!frame || !surface || !panelCanMove()) {
		swap();
		return;
	}
	const parts = () => [...frame.querySelectorAll<HTMLElement>(PARTS)];
	const hidden = parts().map((part) =>
		part.animate({ opacity: [1, 0] }, { duration: HOLD_MS, easing: 'ease', fill: 'forwards' }),
	);
	await ended(hidden, HOLD_MS);

	// The panel is drawn at its full width, cut back to the width it rests at: only the cut moves.
	// The corners are the raised surface's own, which the frame wraps.
	const drawn = surface.firstElementChild ?? surface;
	const round = getComputedStyle(drawn).borderTopRightRadius || '0px';
	const cut = (width: number) => `inset(0 calc(100% - ${String(width)}px) 0 0 round ${round})`;
	const whole = `inset(0 0 0 0 round ${round})`;
	if (widens) {
		const narrow = surface.offsetWidth;
		surface.dataset.rests = String(narrow);
		const move = surface.animate(
			{ clipPath: [cut(narrow), whole] },
			{ duration: MOVE_MS, easing: EASE, fill: 'both' },
		);
		swap();
		await ended([move], MOVE_MS);
		move.cancel();
	} else {
		const narrow = Number(surface.dataset.rests);
		delete surface.dataset.rests;
		if (narrow > 0) {
			const move = surface.animate(
				{ clipPath: [whole, cut(narrow)] },
				{ duration: MOVE_MS, easing: EASE, fill: 'both' },
			);
			await ended([move], MOVE_MS);
			swap();
			move.cancel();
		} else {
			swap();
		}
	}

	for (const part of parts()) {
		part.animate({ opacity: [0, 1] }, { duration: FADE_MS, easing: EASE });
	}
	for (const each of hidden) each.cancel();
}
