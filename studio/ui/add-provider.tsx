import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { kernelAdapters, type StudioProvider } from '../mod.ts';

const DIALOG_WIDTH = 440;

/**
 * Adds a provider to the project: its id, which models name and code keeps, and the adapter it is
 * defined with. What it connects with and its key slots are set in its own editor once it is
 * added. `taken` are the ids the workspace already holds. Compact, it is an icon beside a picker,
 * whose `adapters` are those that serve what picks.
 */
export function AddProviderButton({
	taken,
	onAdd,
	adapters = kernelAdapters(),
	isCompact = false,
}: {
	taken: readonly string[];
	onAdd: (provider: StudioProvider) => void;
	adapters?: readonly string[];
	isCompact?: boolean;
}) {
	const [isOpen, setOpen] = useState(false);
	const [id, setId] = useState('');
	const [adapter, setAdapter] = useState(adapters[0] ?? '');
	const name = id.trim();
	const isTaken = taken.includes(name);
	const add = () => {
		if (!name || isTaken) return;
		onAdd({ id: name, adapter, connection: {} });
		setOpen(false);
	};
	const start = () => {
		setId('');
		setAdapter(adapters[0] ?? '');
		setOpen(true);
	};
	return (
		<>
			{isCompact ? (
				<IconButton
					label="New provider"
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconPlus} size="sm" />}
					tooltip="New provider"
					onClick={start}
				/>
			) : (
				<Button
					label="Add provider"
					variant="ghost"
					size="sm"
					width="100%"
					icon={<Icon icon={IconPlus} size="sm" />}
					style={{ height: 'calc(var(--size-element-sm) - 4px)' }}
					onClick={start}
				/>
			)}
			<Dialog isOpen={isOpen} purpose="form" width={DIALOG_WIDTH} onOpenChange={setOpen}>
				<Layout
					header={
						<DialogHeader
							title="Add provider"
							subtitle="Every agent's models can run on it. Save writes it to your code."
						/>
					}
					content={
						<LayoutContent>
							<VStack gap={4}>
								<TextInput
									label="Id"
									description="What a model's provider says."
									value={id}
									onChange={setId}
									onEnter={add}
									hasAutoFocus
									status={
										isTaken
											? { type: 'error', message: `A provider named '${name}' is already here.` }
											: undefined
									}
								/>
								<SegmentedControl label="Adapter" value={adapter} onChange={setAdapter}>
									{adapters.map((each) => (
										<SegmentedControlItem key={each} value={each} label={each} />
									))}
								</SegmentedControl>
							</VStack>
						</LayoutContent>
					}
					footer={
						<LayoutFooter>
							<HStack gap={2} justify="end">
								<Button
									label="Cancel"
									variant="ghost"
									onClick={() => {
										setOpen(false);
									}}
								/>
								<Button label="Add" variant="primary" isDisabled={!name || isTaken} onClick={add} />
							</HStack>
						</LayoutFooter>
					}
				/>
			</Dialog>
		</>
	);
}
