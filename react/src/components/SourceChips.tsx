import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import { chipsFromBlock } from '../client/source-chips';

export type SourceChipsProps = {
	block: Extract<TranscriptBlock, { kind: 'grounding' | 'evidence' }>;
};

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
