/**
 * The rules behind editing a decision's state as fields: which lists read as
 * words, and what a new row in a list starts as.
 *
 * @module
 */

import type { DecisionJson } from '@theoremjs/agents';

/** A list edited as tokens: empty, or every entry a string. */
export function isWordList(value: DecisionJson[]): value is string[] {
	return value.every((entry) => typeof entry === 'string');
}

/** A new row shaped like `like`: its fields kept, its values emptied. */
export function blankLike(like: DecisionJson | undefined): DecisionJson {
	if (like === undefined || like === null || typeof like === 'string') return '';
	if (typeof like === 'number') return 0;
	if (typeof like === 'boolean') return false;
	if (Array.isArray(like)) return [];
	return Object.fromEntries(Object.entries(like).map(([key, value]) => [key, blankLike(value)]));
}

/** Columns a list of rows edits as a table in, or `null` when its rows are not all small, flat, and alike. */
export function tableColumns(value: DecisionJson[]): { key: string; weight: number }[] | null {
	const first = value[0];
	if (first === undefined || first === null || typeof first !== 'object' || Array.isArray(first)) return null;
	const keys = Object.keys(first);
	if (keys.length === 0 || keys.length > 4) return null;
	const alike = value.every(
		(row) =>
			row !== null &&
			typeof row === 'object' &&
			!Array.isArray(row) &&
			Object.keys(row).join() === keys.join() &&
			Object.values(row).every((cell) => cell === null || typeof cell !== 'object'),
	);
	if (!alike) return null;
	// Wider columns for longer values: a role stays narrow beside its message.
	return keys.map((key) => {
		const lengths = value.map((row) => String((row as Record<string, DecisionJson>)[key] ?? '').length);
		const longest = Math.max(key.length, ...lengths);
		return { key, weight: Math.min(4, Math.max(1, Math.round(longest / 10))) };
	});
}
