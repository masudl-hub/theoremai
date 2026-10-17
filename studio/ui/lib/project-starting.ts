/**
 * The studio's page can be opened a moment before the project's server listens: one command starts
 * both. Nothing answering is then a server still starting, so the page asks again until one does.
 */

/** How long a server has to start listening, and how often the page asks. */
const STARTING_MS = 10_000;
const EVERY_MS = 200;

export interface Clock {
	now(): number;
	wait(ms: number): Promise<void>;
}

const CLOCK: Clock = {
	now: () => performance.now(),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A fetch that reached nothing throws a TypeError; a server that answered badly throws something else. */
const nothingAnswered = (error: unknown) => error instanceof TypeError;

/**
 * What `open` resolves to, asking again while nothing answers. Throws what `open` last threw when
 * a server answers badly, or when none has answered by the time one would have started.
 */
export async function onceAnswering<T>(open: () => Promise<T>, clock: Clock = CLOCK): Promise<T> {
	const until = clock.now() + STARTING_MS;
	for (;;) {
		try {
			return await open();
		} catch (error) {
			if (!nothingAnswered(error) || clock.now() >= until) throw error;
			await clock.wait(EVERY_MS);
		}
	}
}
