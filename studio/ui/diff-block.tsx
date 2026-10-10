import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import type { DiffLine } from '../mod.ts';

/**
 * Changed lines as a unified diff: what goes on `-` lines, what comes on `+` lines, shared lines
 * between. `sides` names the two as a diff's own header does. `marked` is the side that stands.
 */
export function DiffBlock({
	title,
	lines,
	sides,
	marked = '+',
	maxHeight,
}: {
	title?: string;
	lines: readonly DiffLine[];
	/** What the `-` lines and the `+` lines each are. */
	sides?: { removed: string; added: string };
	marked?: '-' | '+';
	maxHeight?: string;
}) {
	const head = sides ? [`--- ${sides.removed}`, `+++ ${sides.added}`] : [];
	return (
		<CodeBlock
			code={[...head, ...lines.map((line) => `${line.sign} ${line.text}`)].join('\n')}
			language="diff"
			title={title}
			size="sm"
			hasCopyButton={false}
			maxHeight={maxHeight}
			highlightLines={lines.flatMap((line, index) =>
				line.sign === marked ? [head.length + index + 1] : [],
			)}
		/>
	);
}
