import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useState } from 'react';
import type { FileConflict } from '../mod.ts';

const DIALOG_WIDTH = 720;

type Side = 'mine' | 'theirs';

/** A conflict's setting as the Save review names one: whose it is, then the path to it. */
function settingName(conflict: FileConflict): string {
	const path = conflict.path
		.map((part) => (typeof part === 'number' ? `#${String(part + 1)}` : part))
		.join('.')
		.replaceAll('.#', ' #');
	return path ? `${conflict.name} · ${path}` : conflict.name;
}

/** One side's value as text. A whole agent or tool is said, not printed. */
function valueText(conflict: FileConflict, side: Side): string {
	const [value, other] =
		side === 'mine' ? [conflict.mine, conflict.theirs] : [conflict.theirs, conflict.mine];
	// A whole agent or tool, or one row of a list, is there or taken out.
	const isWhole = conflict.path.length === 0;
	if (isWhole || typeof conflict.path.at(-1) === 'number') {
		if (value === undefined) return side === 'mine' ? 'Removed here' : 'Removed from your files';
		if (isWhole && other === undefined)
			return side === 'mine' ? 'Kept, with your edits' : 'Kept, and changed';
	}
	if (value === undefined || value === null || value === '') return '(not set)';
	if (typeof value === 'string') return value;
	// A row's key is the studio's own name for it, and says nothing to the builder.
	return JSON.stringify(value, (field, inner: unknown) => (field === 'key' ? undefined : inner), 2);
}

/**
 * The settings the builder and their files both changed, each with the two values side by side
 * and a choice of which stands. Nothing in the studio changes until Apply; closing it leaves the
 * builder's edits standing and the choice still to make.
 */
export function FileConflicts({
	conflicts,
	files,
	onApply,
	onClose,
}: {
	conflicts: readonly FileConflict[];
	/** The files that changed, as the builder reads them: a name, or how many. */
	files: string;
	/** Called with the conflicts to take from the files, by their place in `conflicts`. */
	onApply: (theirs: number[]) => void;
	onClose: () => void;
}) {
	const [picks, setPicks] = useState<Record<number, Side>>({});
	const all = (side: Side) => {
		setPicks(Object.fromEntries(conflicts.map((_, index) => [index, side])));
	};
	const count =
		conflicts.length === 1 ? '1 setting was' : `${String(conflicts.length)} settings were`;
	return (
		<Dialog
			isOpen
			width={DIALOG_WIDTH}
			maxHeight="80vh"
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose();
			}}
		>
			<Layout
				header={
					<DialogHeader
						title="Your files and your edits disagree"
						subtitle={`${count} changed both here and in ${files}. Choose which value each keeps. Nothing changes here until you apply; close this to choose later.`}
					/>
				}
				content={
					<LayoutContent isScrollable={false} padding={0}>
						<ScrollableArea label="Conflicts" height="100%" paddingInline={4}>
							<VStack gap={5}>
								{conflicts.map((conflict, index) => {
									const pick = picks[index] ?? 'mine';
									return (
										<VStack key={`${conflict.kind}:${conflict.key}:${conflict.path.join('.')}`} gap={2}>
											<HStack gap={3} vAlign="center" justify="between">
												<StackItem size="fill">
													<Text weight="semibold">{settingName(conflict)}</Text>
												</StackItem>
												<SegmentedControl
													label={`Which value ${settingName(conflict)} keeps`}
													size="sm"
													value={pick}
													onChange={(next) => {
														setPicks((held) => ({
															...held,
															[index]: next === 'theirs' ? 'theirs' : 'mine',
														}));
													}}
												>
													<SegmentedControlItem value="mine" label="Mine" />
													<SegmentedControlItem value="theirs" label="The file's" />
												</SegmentedControl>
											</HStack>
											<div className="studio-conflict-sides">
												{(['mine', 'theirs'] as const).map((side) => (
													<div key={side} className="studio-conflict-side" data-kept={pick === side}>
														<CodeBlock
															code={valueText(conflict, side)}
															language="text"
															title={side === 'mine' ? 'Mine' : `In ${files}`}
															size="sm"
															hasCopyButton={false}
															hasLanguageLabel={false}
															isWrapped
															maxHeight="16rem"
														/>
													</div>
												))}
											</div>
										</VStack>
									);
								})}
							</VStack>
						</ScrollableArea>
					</LayoutContent>
				}
				footer={
					<LayoutFooter>
						<HStack gap={2} justify="between">
							<HStack gap={2}>
								<Button
									label="Take all from files"
									variant="ghost"
									onClick={() => {
										all('theirs');
									}}
								/>
								<Button
									label="Keep all mine"
									variant="ghost"
									onClick={() => {
										all('mine');
									}}
								/>
							</HStack>
							<Button
								label="Apply"
								variant="primary"
								onClick={() => {
									onApply(conflicts.flatMap((_, index) => (picks[index] === 'theirs' ? [index] : [])));
								}}
							/>
						</HStack>
					</LayoutFooter>
				}
			/>
		</Dialog>
	);
}
