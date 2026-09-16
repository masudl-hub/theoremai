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

export function InterfaceGenerationSelect({
	iface,
	selectedModel = '',
	selectedEffort = '',
	disabled = false,
	onGenerationChange,
}: InterfaceGenerationSelectProps) {
	const [open, setOpen] = useState(false);
	const rootElRef = useRef<HTMLDivElement | null>(null);

	const modelId = selectedModel || defaultInterfaceModel(iface) || '';
	const modelOptions = interfaceModelOptions(iface);
	const effortOptions = interfaceEffortOptions(iface, modelId);
	const showModels = modelSelectEnabled(iface);
	const showEfforts = effortSelectEnabled(iface, modelId);
	const visible = generationSelectEnabled(iface, modelId);

	const effortValue =
		selectedEffort || defaultInterfaceEffort(iface, modelId) || effortOptions[0]?.alias || '';

	const triggerLabel = (() => {
		if (!modelId) return 'model';
		if (showEfforts && effortValue) return `${modelId} · ${effortValue}`;
		return modelId;
	})();

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
	}, [open]);

	function pickModel(nextModelId: string) {
		const nextEffort = defaultInterfaceEffort(iface, nextModelId);
		onGenerationChange?.({
			modelId: nextModelId,
			...(nextEffort ? { effort: nextEffort } : {}),
		});
	}

	function pickEffort(nextEffort: string) {
		if (!modelId) return;
		onGenerationChange?.({ modelId, effort: nextEffort });
	}

	if (!visible) return null;

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
				<span className="iface-gen__trigger-label">{triggerLabel}</span>
				<IconChevronDown size={10} stroke={1.75} aria-hidden="true" />
			</button>

			{open ? (
				<>
					<div
						className="iface-gen__backdrop"
						role="presentation"
						onClick={() => {
							setOpen(false);
						}}
					/>
					<div
						className={
							showModels && showEfforts
								? 'iface-gen__menu iface-gen__menu--dual'
								: 'iface-gen__menu'
						}
						role="dialog"
						aria-label="Generation settings"
					>
						{showModels ? (
							<div className="iface-gen__pane">
								<div className="iface-gen__pane-head">Model</div>
								<ul className="iface-gen__list" role="listbox" aria-label="Model">
									{modelOptions.map((option) => (
										<li key={option.id} role="presentation">
											<button
												className={
													option.id === modelId
														? 'iface-gen__option iface-gen__option--on'
														: 'iface-gen__option'
												}
												aria-selected={option.id === modelId}
												onClick={() => {
													pickModel(option.id);
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
						) : null}

						{showEfforts ? (
							<div className="iface-gen__pane">
								<div className="iface-gen__pane-head">Effort</div>
								<ul className="iface-gen__list" role="listbox" aria-label="Effort">
									{effortOptions.map((option) => (
										<li key={option.alias} role="presentation">
											<button
												className={
													option.alias === effortValue
														? 'iface-gen__option iface-gen__option--on'
														: 'iface-gen__option'
												}
												aria-selected={option.alias === effortValue}
												onClick={() => {
													pickEffort(option.alias);
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
						) : !showModels ? (
							<p className="iface-gen__empty">No generation options.</p>
						) : null}
					</div>
				</>
			) : null}
		</div>
	);
}
