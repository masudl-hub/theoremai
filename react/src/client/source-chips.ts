import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import type { Source } from '../../../src/kernel/mod.ts';

export type SourceChip = {
	key: string;
	label: string;
	href?: string;
	kind: string;
};

export type SourceChipBlock = Extract<TranscriptBlock, { kind: 'citation' | 'evidence' }>;

/** A citation's sources; a provider step names only its kind. */
export function chipsFromBlock(block: SourceChipBlock): SourceChip[] {
	if (block.kind === 'citation') {
		return block.sources.map((source, i) => chipFromSource(source, `c-${String(i)}`));
	}
	return [{ key: 'e-kind', label: block.evidence.kind.replaceAll('_', ' '), kind: 'evidence' }];
}

function chipFromSource(source: Source, key: string): SourceChip {
	return {
		key,
		label: source.title.trim() || hostLabel(source.uri) || source.type,
		href: webHref(source.uri),
		kind: source.type,
	};
}

/**
 * A source is linked only at an http(s) URL. Sources come from the model and
 * from tool output, so a `javascript:`, `data:` or other scheme never becomes
 * a clickable link.
 */
function webHref(uri: string): string | undefined {
	if (!URL.canParse(uri)) return undefined;
	const url = new URL(uri);
	return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
}

function hostLabel(uri: string): string {
	try {
		return new URL(uri).hostname.replace(/^www\./, '');
	} catch {
		return truncate(uri, 40);
	}
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}
