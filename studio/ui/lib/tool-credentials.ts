/**
 * The credentials typed into tool tests, by tool key. In this tab's memory only: never saved, never
 * sent anywhere but the one test request. th30 sees them only as cards.
 */
const credentials = new Map<string, string>();
const listeners = new Set<() => void>();

export function toolCredential(key: string): string {
	return credentials.get(key) ?? '';
}

export function setToolCredential(key: string, value: string): void {
	if (value) credentials.set(key, value);
	else credentials.delete(key);
	for (const listener of listeners) listener();
}

export function subscribeToolCredentials(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
