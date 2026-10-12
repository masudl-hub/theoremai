/**
 * The order the loader runs in: the mark draws, a project's read is mapped on the panel as it pulls
 * in beside the rail, the map fades, and the panel pulls in to the page. What each step does on
 * screen is the caller's; this only decides when.
 */

/**
 * What the loader shows: the mark drawing, the map of a project's read on the panel as it pulls in
 * beside the rail, the map fading out, and nothing once the page has the shell.
 */
export type BootPhase = 'draw' | 'map' | 'leave' | 'done';

/** How long the drawn mark is held before it gives way. */
const HOLD_MS = 90;
const REDUCED_HOLD_MS = 200;

export interface Boot {
	/** Whether a project is read for the page, and so mapped. Never with reduced motion. */
	reads: boolean;
	reduced: boolean;
	/** How long the map takes to fade. */
	fadeMs: number;
	/** Settles when the page under the loader is on screen with its fonts. */
	settled: Promise<unknown>;
	/** Settles when the map has drawn every step of a read that has ended. */
	mapDrawn: Promise<void>;
	markDrawn(): Promise<void>;
	/** Whether the pen has begun. Until it does, the panel is blank and there is nothing to wait out. */
	penHasStarted(): boolean;
	/** Pulls the panel in beside the rail. */
	pullIn(): Promise<unknown>;
	sleep(ms: number): Promise<void>;
	show(phase: 'map' | 'leave'): void;
	/** Pulls the panel in to the page's shape. Called once. */
	reveal(): void;
}

/** Runs the loader. The function returned stops it: nothing more is shown or revealed. */
export function runBoot(boot: Boot): () => void {
	let cancelled = false;
	let revealed = false;
	let pulling = false;

	const reveal = () => {
		if (cancelled || revealed) return;
		revealed = true;
		boot.reveal();
	};

	/* A project's read is drawn once the mark is, loaded or not. The mark gives way as it does for
	   any page, and the map starts on the panel as it pulls in. Settles once the panel is in. */
	const mapped = boot.reads
		? boot
				.markDrawn()
				.then(() => boot.sleep(HOLD_MS))
				.then(() => {
					if (cancelled || revealed) return false;
					pulling = true;
					boot.show('map');
					return boot.pullIn().then(() => !cancelled);
				})
		: Promise.resolve(false);

	/* If the page is ready before the pen starts, no mark was ever on screen and the panel pulls in
	   at once. Once the pen has started, it finishes, and so does a map. */
	void boot.settled
		.then(() => {
			if (!boot.reduced && !pulling && !boot.penHasStarted()) return undefined;
			if (!boot.reads) return boot.markDrawn().then(() => boot.sleep(boot.reduced ? REDUCED_HOLD_MS : HOLD_MS));
			return mapped.then((shown) => {
				if (!shown || cancelled) return undefined;
				return boot.mapDrawn.then(() => {
					if (cancelled) return undefined;
					boot.show('leave');
					return boot.sleep(boot.fadeMs);
				});
			});
		})
		.then(reveal);

	return () => {
		cancelled = true;
	};
}
