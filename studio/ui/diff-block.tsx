import type { DiffLine } from '../mod.ts';

const SIGN_LABEL = { ' ': undefined, '-': 'Removed', '+': 'Added' } as const;

/**
 * Changed lines as a unified diff: removed lines red, added lines green, the lines both share
 * between. `sides` names what the `-` and the `+` lines each are. `start` numbers the lines as
 * the file had them. `kept` is the side that stands, and the other reads as set aside.
 */
export function DiffBlock({
	title,
	lines,
	sides,
	start,
	kept,
	isWrapped = false,
	maxHeight,
}: {
	title?: string;
	lines: readonly DiffLine[];
	/** What the `-` lines and the `+` lines each are. */
	sides?: { removed: string; added: string };
	/** The one-based line of the file the first line is. Without it the lines are not numbered. */
	start?: number;
	kept?: '-' | '+';
	/** Whether a long line wraps, for text read as prose. Code scrolls sideways. */
	isWrapped?: boolean;
	maxHeight?: string;
}) {
	const count = (sign: DiffLine['sign']) => lines.filter((line) => line.sign === sign).length;
	// A line the change adds is not one the file had, so it takes no number.
	let at = (start ?? 1) - 1;
	return (
		<figure className="studio-diff" data-wrapped={isWrapped} data-kept={kept}>
			<figcaption className="studio-diff-head">
				{sides ? (
					<span className="studio-diff-sides">
						<span data-sign="-">{`− ${sides.removed}`}</span>
						<span data-sign="+">{`+ ${sides.added}`}</span>
					</span>
				) : (
					<span className="studio-diff-title">{title}</span>
				)}
				<span className="studio-diff-count">
					<span data-sign="+">{`+${String(count('+'))}`}</span>
					<span data-sign="-">{`−${String(count('-'))}`}</span>
				</span>
			</figcaption>
			<div className="studio-diff-lines" style={{ maxHeight }}>
				{lines.map((line, index) => {
					if (line.sign !== '+') at += 1;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no other identity
						<div key={index} className="studio-diff-line" data-sign={line.sign}>
							{start !== undefined && (
								<span className="studio-diff-number" aria-hidden>
									{line.sign === '+' ? '' : String(at)}
								</span>
							)}
							<span className="studio-diff-sign" role="img" aria-label={SIGN_LABEL[line.sign]}>
								{line.sign === '-' ? '−' : line.sign}
							</span>
							<code>{line.text || ' '}</code>
						</div>
					);
				})}
			</div>
		</figure>
	);
}
