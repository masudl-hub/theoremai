import type { ClientTurnOptions } from '@theoremjs/agents/host';
import type { StudioRunsOn } from './lent-keys.ts';

/**
 * Who reads what the studio runs: the builder, on their own machine and keys. A failure says what
 * actually happened (no key in a slot, a rejected key, an unreachable server) instead of the
 * visitor wording. Every handler the studio serves and every run it makes in the page words its
 * replies with this; a run on lent keys is a visitor's, and words its own with `studioReader`.
 */
export const STUDIO_READER: ClientTurnOptions = { reader: 'builder' };

/** Who reads a run: a visitor on lent keys, else the builder (`STUDIO_READER`). */
export function studioReader(on: StudioRunsOn): ClientTurnOptions {
  return on.mode === 'demo' ? { reader: 'visitor' } : STUDIO_READER;
}
