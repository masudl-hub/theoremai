/**
 * For the host's OAuth callback page, opened as the chat's sign-in popup.
 *
 * @module
 */

import { OAUTH_COMPLETE } from './oauth-popup';

/**
 * Tell the chat that opened this popup that `slot`'s token is saved. Call it on
 * the callback page once the credential is in the host's credential store; the
 * message names only the slot and goes only to this page's own origin.
 */
export function notifyOAuthComplete(slot: string): void {
	globalThis.opener?.postMessage({ type: OAUTH_COMPLETE, slot }, globalThis.location.origin);
}
