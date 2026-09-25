/**
 * The OAuth sign-in popup's word back to the chat that opened it.
 *
 * The host's callback route saves the token on the server, then its page calls
 * `notifyOAuthComplete(slot)`. The chat takes the message only from the popup
 * it opened, on its own origin, for the slot its gate waits for, and resumes
 * the gate: no token ever reaches the browser.
 *
 * @module
 */

import { isRecord } from '../../../src/kernel/util/record.ts';

const OAUTH_COMPLETE = 'theorem.oauth_complete';

/**
 * Tell the chat that opened this popup that `slot`'s token is saved. Call it on
 * the callback page once the credential is in the host's credential store. On a
 * page no chat opened, it does nothing.
 */
export function notifyOAuthComplete(slot: string): void {
	const opener: unknown = Reflect.get(globalThis, 'opener');
	if (!isRecord(opener) || typeof opener.postMessage !== 'function') return;
	opener.postMessage({ type: OAUTH_COMPLETE, slot }, globalThis.location.origin);
}

/** The message is `popup`'s, from `origin` (the chat page's own), saying `slot` is signed in. */
export function isOAuthComplete(
	event: { data: unknown; source: unknown; origin: string },
	expected: { popup: unknown; slot: string; origin: string },
): boolean {
	if (event.source !== expected.popup || event.origin !== expected.origin) return false;
	const data: unknown = event.data;
	return isRecord(data) && data.type === OAUTH_COMPLETE && data.slot === expected.slot;
}
