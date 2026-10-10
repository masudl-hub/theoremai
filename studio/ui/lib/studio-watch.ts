/**
 * Watching the project's files from the page: the local server says when the builder's editor
 * writes one, and the builder can turn the watching off. The choice is kept in this browser.
 */
const WATCH_KEY = 'theorem.studio.watch';

function local(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Whether the builder wants the studio to take in file changes as they are written. On unless turned off. */
export function watchWanted(): boolean {
	return local()?.getItem(WATCH_KEY) !== 'off';
}

export function setWatchWanted(on: boolean): void {
	try {
		if (on) local()?.removeItem(WATCH_KEY);
		else local()?.setItem(WATCH_KEY, 'off');
	} catch {
		// A browser that keeps nothing watches until the page is closed.
	}
}

/**
 * Listens for the files the server says changed. `onOpen` runs when the server is watching: one
 * started with `--no-watch` never opens. Answers how to stop listening.
 */
export function subscribeToFiles(
	endpoint: string,
	on: { open: () => void; files: (files: string[]) => void },
): () => void {
	if (typeof EventSource === 'undefined') return () => undefined;
	const source = new EventSource(`${endpoint}/watch`);
	source.onopen = on.open;
	source.onmessage = (event: MessageEvent<string>) => {
		try {
			const told: unknown = JSON.parse(event.data);
			const files =
				typeof told === 'object' && told !== null && 'files' in told ? told.files : undefined;
			on.files(Array.isArray(files) ? files.filter((file) => typeof file === 'string') : []);
		} catch {
			on.files([]);
		}
	};
	return () => {
		source.close();
	};
}
