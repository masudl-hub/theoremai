import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { type ReactNode, useCallback, useState } from 'react';
import { type WriteAsk, writeAskLine } from '../mod.ts';

const DIALOG_WIDTH = 520;

/**
 * The stop before a real run of a tool that writes: the input it would send, and Cancel or Run.
 * `confirm` answers once the builder chose; closing the dialog is Cancel. A second question while
 * one is open is refused, so each run is one the builder read.
 */
export function useConfirmWrite(): {
	confirm: (ask: WriteAsk) => Promise<boolean>;
	dialog: ReactNode;
} {
	const [open, setOpen] = useState<{ ask: WriteAsk; answer: (run: boolean) => void }>();
	const confirm = useCallback(
		(ask: WriteAsk) =>
			new Promise<boolean>((resolve) => {
				setOpen((current) => {
					if (current) {
						resolve(false);
						return current;
					}
					return { ask, answer: resolve };
				});
			}),
		[],
	);
	const answer = (run: boolean) => {
		open?.answer(run);
		setOpen(undefined);
	};
	const dialog = (
		<Dialog
			isOpen={open !== undefined}
			purpose="form"
			width={DIALOG_WIDTH}
			maxHeight="80vh"
			onOpenChange={(isOpen) => {
				if (!isOpen) answer(false);
			}}
		>
			{open && (
				<VStack gap={4}>
					<DialogHeader title={`Run ${open.ask.tool}?`} subtitle={writeAskLine(open.ask)} />
					<CodeBlock
						code={open.ask.input}
						language="json"
						title="Input"
						size="sm"
						isWrapped
						maxHeight={320}
					/>
					<HStack gap={2} justify="end">
						<Button
							label="Cancel"
							variant="ghost"
							onClick={() => {
								answer(false);
							}}
						/>
						<Button
							label="Run"
							onClick={() => {
								answer(true);
							}}
						/>
					</HStack>
				</VStack>
			)}
		</Dialog>
	);
	return { confirm, dialog };
}
