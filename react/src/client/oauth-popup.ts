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

/** The message type the callback page posts; see `notifyOAuthComplete`. */
export const OAUTH_COMPLETE = 'theorem.oauth_complete';

/** The message is `popup`'s, from `origin` (the chat page's own), saying `slot` is signed in. */
export function isOAuthComplete(
	event: MessageEvent,
	expected: { popup: Window; slot: string; origin: string },
): boolean {
	if (event.source !== expected.popup || event.origin !== expected.origin) return false;
	const data: unknown = event.data;
	return (
		typeof data === 'object' &&
		data !== null &&
		'type' in data &&
		data.type === OAUTH_COMPLETE &&
		'slot' in data &&
		data.slot === expected.slot
	);
}
