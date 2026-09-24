import { type LexiconOverrides, lexiconText, type SessionEvent } from '../../../../mod.ts';

/**
 * What the user reads when the provider ended the session after warning it
 * would: the host's wording, else the profile lexicon's `live.session_ended`.
 */
export function sessionEndedText(session: SessionEvent, lexicon?: LexiconOverrides): string {
	return session.message ?? lexiconText('live.session_ended', {}, lexicon);
}
