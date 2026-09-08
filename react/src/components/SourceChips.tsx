import type { TranscriptBlock } from 'theorum/interface';
import type { GroundingSource } from 'theorum/kernel';

export type SourceChipsProps = {
	block: Extract<TranscriptBlock, { kind: 'grounding' | 'evidence' }>;
};

type Chip = {
	key: string;
	label: string;
	href?: string;
	kind: string;
};

function chipsFromBlock(block: SourceChipsProps['block']): Chip[] {
	const chips: Chip[] = [];

	if (block.kind === 'grounding') {
		for (const [i, source] of block.grounding.sources.entries()) {
			chips.push(chipFromSource(source, `g-${String(i)}`));
		}
		return chips;
	}

	const evidence = block.evidence;
	if (evidence.sources) {
		for (const [i, source] of evidence.sources.entries()) {
			chips.push(chipFromSource(source, `e-src-${String(i)}`));
		}
	}
	if (evidence.citations) {
		for (const [i, citation] of evidence.citations.entries()) {
			const href = citation.startsWith('http') ? citation : undefined;
			chips.push({
				key: `e-cit-${String(i)}`,
				label: href ? hostLabel(href) : truncate(citation, 48),
				href,
				kind: 'citation',
			});
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

function chipFromSource(source: GroundingSource, key: string): Chip {
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

export function SourceChips({ block }: SourceChipsProps) {
	const chips = chipsFromBlock(block);
	if (chips.length === 0) return null;

	return (
		<ul className="iface-sources" aria-label="Sources">
			{chips.map((chip) => (
				<li key={chip.key} className="iface-sources__item">
					{chip.href ? (
						<a
							className="iface-sources__chip"
							href={chip.href}
							target="_blank"
							rel="noopener noreferrer"
							title={chip.href}
						>
							<span className="iface-sources__kind">{chip.kind}</span>
							<span className="iface-sources__label">{chip.label}</span>
						</a>
					) : (
						<span className="iface-sources__chip" title={chip.label}>
							<span className="iface-sources__kind">{chip.kind}</span>
							<span className="iface-sources__label">{chip.label}</span>
						</span>
					)}
				</li>
			))}
		</ul>
	);
}
