import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';
import { useState, useSyncExternalStore } from 'react';
import { sharedAsk } from '../mod.ts';
import type { StudioStore } from './lib/studio-store.ts';

const DIALOG_WIDTH = 520;

/**
 * The stop before a change to a value the project's files write once: who else it changes, and
 * Cancel or Change for all. Closing the dialog is Cancel, and no profile has the change.
 */
export function SharedChange({ store }: { store: StudioStore }) {
	const reach = useSyncExternalStore(store.subscribe, store.getPending, store.getPending);
	const [quiet, setQuiet] = useState(false);
	const ask = reach && sharedAsk(reach, store.getWorkspace());
	return (
		<Dialog
			isOpen={reach !== undefined}
			purpose="form"
			width={DIALOG_WIDTH}
			onOpenChange={(isOpen) => {
				if (!isOpen) store.cancelShared();
			}}
		>
			{ask && (
				<VStack gap={4}>
					<DialogHeader title={ask.title} subtitle={ask.line} />
					<CheckboxInput label="Don't ask again this session" value={quiet} onChange={setQuiet} />
					<HStack gap={2} justify="end">
						<Button
							label="Cancel"
							variant="ghost"
							onClick={() => {
								store.cancelShared();
							}}
						/>
						<Button
							label={reach.agents.length ? 'Change for all' : 'Change'}
							variant="primary"
							onClick={() => {
								store.confirmShared(quiet);
							}}
						/>
					</HStack>
				</VStack>
			)}
		</Dialog>
	);
}
