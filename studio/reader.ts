import type { ClientTurnOptions } from '@theoremjs/agents/host';

/**
 * Who reads what the studio runs: the builder, on their own machine and keys. A failure says what
 * actually happened (no key in a slot, a rejected key, an unreachable server) instead of the
 * visitor wording. Every handler the studio serves and every run it makes in the page words its
 * replies with this; the hosted demo runs on the site's keys, and words its own for a visitor.
 */
export const STUDIO_READER: ClientTurnOptions = { reader: 'builder' };
