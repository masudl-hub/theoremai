import type { SaveRefusal } from '../../server/save-wire.ts';

/** A refusal's detail as lines the builder reads: what did not load as edited, or what the project said. */
export function refusalLines(refusal: SaveRefusal): string[] {
	if (refusal.detail.length === 0) return [];
	if (refusal.reason === 'differs') return [`Not loading as edited: ${refusal.detail.join(', ')}.`];
	return refusal.detail.flatMap((each) => each.split('\n')).filter((line) => line.trim() !== '');
}
