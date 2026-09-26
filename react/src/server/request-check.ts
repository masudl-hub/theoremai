/**
 * What a browser sends a host, checked: the handler's request bodies and a
 * relay's live messages. A malformed one is a `request` error, which names
 * only the paths and codes that broke, never the value.
 *
 * @module
 */

import { TheoremError, type z } from '../../../mod.ts';
import { type LiveClientMessage, liveClientMessageSchema } from '../client/live-messages.ts';
import { issueSummary } from '../client/wire-line.ts';

/** `raw` checked against `schema`; a missing or malformed field is a `request` error. */
export function checkRequest<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', `${what} failed its check: ${issueSummary(parsed.error)}`);
	}
	return parsed.data;
}

/**
 * One text frame from the live client, as a relay reads it: JSON that passes
 * `liveClientMessageSchema`, else a `request` error.
 */
export function parseLiveClientMessage(text: string): LiveClientMessage {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (cause) {
		// lexicon-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
		throw new TheoremError('request', 'live message must be JSON', { cause });
	}
	return checkRequest(liveClientMessageSchema, raw, 'live message');
}
