import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton';
import { VStack } from '@astryxdesign/core/VStack';
import { createContext, useState } from 'react';
import { type FileConflict, lineDiff } from '../mod.ts';
import { DiffBlock } from './diff-block.tsx';

const DIALOG_WIDTH = 720;
const DIFF_MAX_HEIGHT = '20rem';

/** Opens the choice a Save waits on, while the files and the builder's edits conflict. */
export const ChooseConflictsContext = createContext<(() => void) | undefined>(undefined);

/** The two values a conflict holds: the studio's unsaved edit, and what the source code now says. */
type Side = 'studio' | 'source';

const SIDE_NAME = { studio: 'Studio edit', source: 'Source code' } as const;

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
		side === 'studio' ? [conflict.mine, conflict.theirs] : [conflict.theirs, conflict.mine];
	// A whole agent or tool, or one row of a list, is there or taken out.
	const isWhole = conflict.path.length === 0;
	if (isWhole || typeof conflict.path.at(-1) === 'number') {
		if (value === undefined) return '(removed)';
		if (isWhole && other === undefined)
			return side === 'studio' ? '(kept, with studio edits)' : '(kept, and changed)';
	}
	if (value === undefined || value === null || value === '') return '(not set)';
	if (typeof value === 'string') return value;
	// A row's key is the studio's own name for it, and says nothing to the builder.
	return JSON.stringify(value, (field, inner: unknown) => (field === 'key' ? undefined : inner), 2);
}

/**
 * The settings the studio and the source code both changed, each as a diff from the source code's
 * value to the studio edit, and a choice of which stands. Resolving puts the chosen values in the
 * studio; the source code is written at Save. Closing leaves the studio edits standing and the
 * choice still to make.
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
	/** Called with the conflicts to take from the source code, by their place in `conflicts`. */
	onApply: (theirs: number[]) => void;
	onClose: () => void;
}) {
	const [picks, setPicks] = useState<Record<number, Side>>({});
	const all = (side: Side) => {
		setPicks(Object.fromEntries(conflicts.map((_, index) => [index, side])));
	};
	const one = conflicts.length === 1;
	const count = one ? '1 setting' : `${String(conflicts.length)} settings`;
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
						title="Studio edits conflict with source code"
						subtitle={`${count} changed both in the studio and in ${files}. Choose which value each keeps.`}
					/>
				}
				content={
					<LayoutContent isScrollable={false} padding={0}>
						<ScrollableArea label="Conflicts" height="100%" paddingInline={4}>
							<VStack gap={5}>
								{conflicts.map((conflict, index) => {
									const pick = picks[index] ?? 'studio';
									const name = settingName(conflict);
									return (
										<VStack key={`${conflict.kind}:${conflict.key}:${conflict.path.join('.')}`} gap={2}>
											<HStack gap={3} vAlign="center" justify="between">
												<StackItem size="fill">
													<Text weight="semibold">{name}</Text>
												</StackItem>
												<ToggleButtonGroup
													label={`Which value ${name} keeps`}
													size="sm"
													value={pick}
													onChange={(next) => {
														// Pressing the kept one again leaves it kept: one always stands.
														if (next === 'studio' || next === 'source')
															setPicks((held) => ({ ...held, [index]: next }));
													}}
												>
													<ToggleButton value="source" label="Keep source code" />
													<ToggleButton value="studio" label="Keep studio edit" />
												</ToggleButtonGroup>
											</HStack>
											<DiffBlock
												lines={lineDiff(valueText(conflict, 'source'), valueText(conflict, 'studio'))}
												sides={{
													removed: `${SIDE_NAME.source} (${files})`,
													added: SIDE_NAME.studio,
												}}
												marked={pick === 'studio' ? '+' : '-'}
												maxHeight={DIFF_MAX_HEIGHT}
											/>
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
								{!one && (
									<>
										<Button
											label="Keep all source code"
											variant="ghost"
											onClick={() => {
												all('source');
											}}
										/>
										<Button
											label="Keep all studio edits"
											variant="ghost"
											onClick={() => {
												all('studio');
											}}
										/>
									</>
								)}
							</HStack>
							<Button
								label={one ? 'Resolve conflict' : `Resolve ${String(conflicts.length)} conflicts`}
								variant="primary"
								onClick={() => {
									onApply(conflicts.flatMap((_, index) => (picks[index] === 'source' ? [index] : [])));
								}}
							/>
						</HStack>
					</LayoutFooter>
				}
			/>
		</Dialog>
	);
}
