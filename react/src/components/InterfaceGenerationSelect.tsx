import { IconChevronDown } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import {
	type ComposerProfileInterface,
	defaultInterfaceEffort,
	defaultInterfaceModel,
	effortSelectEnabled,
	generationSelectEnabled,
	interfaceEffortOptions,
	interfaceModelOptions,
	modelSelectEnabled,
} from '../../../src/interface/mod.ts';

export type InterfaceGenerationSelectProps = {
	iface: ComposerProfileInterface;
	selectedModel?: string;
	selectedEffort?: string;
	disabled?: boolean;
	onGenerationChange?: (next: { modelId: string; effort?: string }) => void;
};

function useGenerationSelectDismiss(
	open: boolean,
	rootElRef: React.RefObject<HTMLDivElement | null>,
	setOpen: (open: boolean) => void,
) {
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false);
		};
		const onDocPointer = (event: PointerEvent) => {
			const rootEl = rootElRef.current;
			if (!rootEl) return;
			if (event.target instanceof Node && rootEl.contains(event.target)) return;
			setOpen(false);
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', onDocPointer, { capture: true });
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onDocPointer, { capture: true });
		};
	}, [open, rootElRef, setOpen]);
}

function ModelOptionPane({
	modelOptions,
	selectedModelId,
	onPickModel,
}: {
	modelOptions: ReturnType<typeof interfaceModelOptions>;
	selectedModelId: string;
	onPickModel: (id: string) => void;
}) {
	return (
		<div className="iface-gen__pane">
			<div className="iface-gen__pane-head">Model</div>
			<ul className="iface-gen__list" role="listbox" aria-label="Model">
				{modelOptions.map((option) => (
					<li key={option.id} role="presentation">
						<button
							className={
								option.id === selectedModelId
									? 'iface-gen__option iface-gen__option--on'
									: 'iface-gen__option'
							}
							aria-selected={option.id === selectedModelId}
							onClick={() => {
								onPickModel(option.id);
							}}
							role="option"
							type="button"
						>
							<span className="iface-gen__option-id">{option.id}</span>
							{option.label !== option.id ? (
								<span className="iface-gen__option-meta">{option.label}</span>
							) : null}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function EffortOptionPane({
	effortOptions,
	selectedEffort,
	onPickEffort,
}: {
	effortOptions: ReturnType<typeof interfaceEffortOptions>;
	selectedEffort: string;
	onPickEffort: (alias: string) => void;
}) {
	return (
		<div className="iface-gen__pane">
			<div className="iface-gen__pane-head">Effort</div>
			<ul className="iface-gen__list" role="listbox" aria-label="Effort">
				{effortOptions.map((option) => (
					<li key={option.alias} role="presentation">
						<button
							className={
								option.alias === selectedEffort
									? 'iface-gen__option iface-gen__option--on'
									: 'iface-gen__option'
							}
							aria-selected={option.alias === selectedEffort}
							onClick={() => {
								onPickEffort(option.alias);
							}}
							role="option"
							type="button"
						>
							<span className="iface-gen__option-id">{option.alias}</span>
							<span className="iface-gen__option-meta">{option.level}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function GenerationMenuDialog({
	showModels,
	showEfforts,
	modelOptions,
	effortOptions,
	modelId,
	effortValue,
	onPickModel,
	onPickEffort,
	onClose,
}: {
	showModels: boolean;
	showEfforts: boolean;
	modelOptions: ReturnType<typeof interfaceModelOptions>;
	effortOptions: ReturnType<typeof interfaceEffortOptions>;
	modelId: string;
	effortValue: string;
	onPickModel: (id: string) => void;
	onPickEffort: (alias: string) => void;
	onClose: () => void;
}) {
	const menuClass =
		showModels && showEfforts ? 'iface-gen__menu iface-gen__menu--dual' : 'iface-gen__menu';

	return (
		<>
			<div className="iface-gen__backdrop" role="presentation" onClick={onClose} />
			<div className={menuClass} role="dialog" aria-label="Generation settings">
				{showModels ? (
					<ModelOptionPane
						modelOptions={modelOptions}
						selectedModelId={modelId}
						onPickModel={onPickModel}
					/>
				) : null}

				{showEfforts ? (
					<EffortOptionPane
						effortOptions={effortOptions}
						selectedEffort={effortValue}
						onPickEffort={onPickEffort}
					/>
				) : !showModels ? (
					<p className="iface-gen__empty">No generation options.</p>
				) : null}
			</div>
		</>
	);
}

function resolveGenerationLabel(modelId: string, showEfforts: boolean, effortValue: string) {
	if (!modelId) return 'model';
	if (showEfforts && effortValue) return `${modelId} · ${effortValue}`;
	return modelId;
}

function useGenerationSelectState(args: {
	iface: ComposerProfileInterface;
	selectedModel: string;
	selectedEffort: string;
	onGenerationChange?: (next: { modelId: string; effort?: string }) => void;
}) {
	const modelId = args.selectedModel || defaultInterfaceModel(args.iface) || '';
	const modelOptions = interfaceModelOptions(args.iface);
	const effortOptions = interfaceEffortOptions(args.iface, modelId);
	const showModels = modelSelectEnabled(args.iface);
	const showEfforts = effortSelectEnabled(args.iface, modelId);
	const visible = generationSelectEnabled(args.iface, modelId);

	const effortValue =
		args.selectedEffort || defaultInterfaceEffort(args.iface, modelId) || effortOptions[0]?.alias || '';

	const triggerLabel = resolveGenerationLabel(modelId, showEfforts, effortValue);

	function pickModel(nextModelId: string) {
		const nextEffort = defaultInterfaceEffort(args.iface, nextModelId);
		args.onGenerationChange?.({
			modelId: nextModelId,
			...(nextEffort ? { effort: nextEffort } : {}),
		});
	}

	function pickEffort(nextEffort: string) {
		if (!modelId) return;
		args.onGenerationChange?.({ modelId, effort: nextEffort });
	}

	return {
		modelId,
		modelOptions,
		effortOptions,
		showModels,
		showEfforts,
		visible,
		effortValue,
		triggerLabel,
		pickModel,
		pickEffort,
	};
}

export function InterfaceGenerationSelect({
	iface,
	selectedModel = '',
	selectedEffort = '',
	disabled = false,
	onGenerationChange,
}: InterfaceGenerationSelectProps) {
	const [open, setOpen] = useState(false);
	const rootElRef = useRef<HTMLDivElement | null>(null);

	const state = useGenerationSelectState({
		iface,
		selectedModel,
		selectedEffort,
		onGenerationChange,
	});

	useGenerationSelectDismiss(open, rootElRef, setOpen);

	if (!state.visible) return null;

	return (
		<div ref={rootElRef} className="iface-gen">
			<button
				className="iface-gen__trigger"
				aria-expanded={open}
				aria-haspopup="dialog"
				disabled={disabled}
				onClick={() => {
					if (!disabled) setOpen((prev) => !prev);
				}}
				type="button"
			>
				<span className="iface-gen__trigger-label">{state.triggerLabel}</span>
				<IconChevronDown size={10} stroke={1.75} aria-hidden="true" />
			</button>

			{open ? (
				<GenerationMenuDialog
					showModels={state.showModels}
					showEfforts={state.showEfforts}
					modelOptions={state.modelOptions}
					effortOptions={state.effortOptions}
					modelId={state.modelId}
					effortValue={state.effortValue}
					onPickModel={state.pickModel}
					onPickEffort={state.pickEffort}
					onClose={() => {
						setOpen(false);
					}}
				/>
			) : null}
		</div>
	);
}
