import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import type { GroundingSource } from '../../../src/kernel/mod.ts';

export type SourceChip = {
	key: string;
	label: string;
	href?: string;
	kind: string;
};

export type SourceChipBlock = Extract<TranscriptBlock, { kind: 'grounding' | 'evidence' }>;

export function chipsFromBlock(block: SourceChipBlock): SourceChip[] {
	if (block.kind === 'grounding') {
		return block.grounding.sources.map((source, i) => chipFromSource(source, `g-${String(i)}`));
	}
	return chipsFromEvidence(block.evidence);
}

function chipsFromEvidence(evidence: Extract<SourceChipBlock, { kind: 'evidence' }>['evidence']): SourceChip[] {
	const chips: SourceChip[] = [];

	if (evidence.sources) {
		for (const [i, source] of evidence.sources.entries()) {
			chips.push(chipFromSource(source, `e-src-${String(i)}`));
		}
	}
	if (evidence.citations) {
		for (const [i, citation] of evidence.citations.entries()) {
			chips.push(chipFromCitation(citation, i));
		}
	}
	if (chips.length === 0 && evidence.kind) {
		chips.push({
			key: 'e-kind',
			label: evidence.kind.replaceAll('_', ' '),
			kind: 'evidence',
		});
	}
	return chips;
}

function chipFromCitation(citation: string, index: number): SourceChip {
	const href = citation.startsWith('http') ? citation : undefined;
	return {
		key: `e-cit-${String(index)}`,
		label: href ? hostLabel(href) : truncate(citation, 48),
		href,
		kind: 'citation',
	};
}

function chipFromSource(source: GroundingSource, key: string): SourceChip {
	return {
		key,
		label: source.title.trim() || hostLabel(source.uri) || source.type,
		href: source.uri || undefined,
		kind: source.type,
	};
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
