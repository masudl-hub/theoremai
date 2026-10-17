/**
 * Where the page finds the project's local server. The studio's own page is told in its document,
 * by the command that started both; any other page looks where the first studio on this machine
 * listens.
 */
export const PROJECT_META = 'theorem-studio-project';
export const FIRST_PROJECT_ENDPOINT = 'http://127.0.0.1:4983/api/studio';

export function projectEndpoint(): string {
	if (typeof document === 'undefined') return FIRST_PROJECT_ENDPOINT;
	return document.querySelector<HTMLMetaElement>(`meta[name="${PROJECT_META}"]`)?.content ?? FIRST_PROJECT_ENDPOINT;
}

/**
 * Where the screen's own requests go: the guardrail probe and the key and connection tests. The
 * studio's own page has no server of its own, so they go to the project's; any other page answers
 * them itself, under `/api/studio`.
 */
export function screenEndpoint(): string {
	if (typeof document === 'undefined') return '/api/studio';
	return document.querySelector<HTMLMetaElement>(`meta[name="${PROJECT_META}"]`)?.content ?? '/api/studio';
}
