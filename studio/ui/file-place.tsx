import { HoverCard } from '@astryxdesign/core/HoverCard';
import { HStack } from '@astryxdesign/core/HStack';
import { useClipboard } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Fragment, type ReactNode } from 'react';
import { type Ask, type AskPlace, askParts, shortPlace } from '../mod.ts';

/** A line of a file by the file's name. Hovering shows where the file is, with a copy. */
function FilePlace({ place }: { place: AskPlace }) {
	const { copy, isCopied } = useClipboard();
	const full = `${place.file}:${String(place.line)}`;
	return (
		<HoverCard
			label={full}
			touchTrigger="tap"
			content={
				<HStack gap={2} vAlign="center">
					<Text type="code" size="sm">
						{full}
					</Text>
					<IconButton
						label={isCopied ? 'Copied' : 'Copy path'}
						variant="ghost"
						size="sm"
						icon={<Icon icon={isCopied ? IconCheck : IconCopy} size="sm" />}
						onClick={() => {
							copy(full);
						}}
					/>
				</HStack>
			}
		>
			{shortPlace(place)}
		</HoverCard>
	);
}

/** A question's line, with each file it names by its name. */
export function askLine(ask: Ask): ReactNode {
	let at = 0;
	return askParts(ask).map((part) => {
		at += 1;
		return (
			<Fragment key={at}>{typeof part === 'string' ? part : <FilePlace place={part} />}</Fragment>
		);
	});
}
