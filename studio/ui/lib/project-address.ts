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
