/**
 * Why the studio could not run or save the builder's edits, past the headline: the agents and
 * tools that did not load as edited, or what the project said when it stopped.
 */
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { SaveRefusal } from '../server/save-wire.ts';

/** More lines than this scroll, so a long report does not push the way out off the pane. */
const LINES_SHOWN = 12;
const SCROLL_HEIGHT = 240;

/** The refusal's detail as lines the builder reads. */
export function refusalLines(refusal: SaveRefusal): string[] {
	if (refusal.detail.length === 0) return [];
	if (refusal.reason === 'differs') return [`Not loading as edited: ${refusal.detail.join(', ')}.`];
	return refusal.detail.flatMap((each) => each.split('\n')).filter((line) => line.trim() !== '');
}

export function RefusalDetail({ refusal }: { refusal: SaveRefusal }) {
	const lines = refusalLines(refusal);
	if (lines.length === 0) return null;
	const said = (
		<VStack gap={1}>
			{lines.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a report's lines keep their order, and two may say the same.
				<Text key={index} type="supporting" color="secondary" wordBreak="break-word">
					{line}
				</Text>
			))}
		</VStack>
	);
	if (lines.length <= LINES_SHOWN) return said;
	return (
		<ScrollableArea label="Details" height={SCROLL_HEIGHT}>
			{said}
		</ScrollableArea>
	);
}
