import type {
	ComposerPendingMessage,
	ComposerProfileInterface,
	ComposerRunPhase,
} from 'theorum/interface';
import type { ComposerFieldHandlers } from './composer-field-handlers';
import { ComposerPendingBar } from './ComposerPendingBar';
import { InterfaceComposer } from './InterfaceComposer';
import { InterfaceGenerationSelect } from './InterfaceGenerationSelect';

function InlineRunError(props: { error: string; errorInternal: string }) {
	if (!props.error) return null;
	return (
		<div
			className={
				props.errorInternal
					? 'iface-inline-error iface-inline-error--detail'
					: 'iface-inline-error'
			}
			role="alert"
			tabIndex={props.errorInternal ? 0 : undefined}
		>
			<p className="iface-inline-error__public">{props.error}</p>
			{props.errorInternal ? (
				<pre className="iface-inline-error__internal">{props.errorInternal}</pre>
			) : null}
		</div>
	);
}

/** Composer rail: pending bar, composer, generation select. */
export function InterfaceRunnerComposer(props: {
	iface: ComposerProfileInterface;
	chatStarted: boolean;
	draftText: string;
	pendingFiles: File[];
	pendingVoice: File[];
	pendingMessages: readonly ComposerPendingMessage[];
	issues: string[];
	phase: ComposerRunPhase;
	error: string;
	errorInternal: string;
	streaming: boolean;
	selectedModel: string;
	selectedEffort: string;
	onGenerationChange?: (next: { modelId: string; effort?: string }) => void;
	onPendingRemove?: (id: string) => void;
	onPendingMove?: (id: string, direction: 'up' | 'down') => void;
	onPendingQueue?: (id: string) => void;
	onPendingSendNow?: (id: string) => void;
	onPendingRestore?: (id: string) => void;
} & ComposerFieldHandlers) {
	const allowSteering = 'allowSteering' in props.iface ? props.iface.allowSteering : false;
	const handleLabel = `@${props.iface.identity.handle}`;
	const slotClass = [
		'iface-composer-slot',
		!props.chatStarted ? 'iface-composer-slot--landing' : '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div className="iface-rail">
			<div className={slotClass}>
				{!props.chatStarted ? (
					<header className="iface-head">
						<h1 className="iface-head__handle">{handleLabel}</h1>
					</header>
				) : null}

				<div className="iface-composer-wrap">
					<InlineRunError error={props.error} errorInternal={props.errorInternal} />
					<ComposerPendingBar
						messages={props.pendingMessages}
						onMove={props.onPendingMove}
						onQueue={props.onPendingQueue}
						onRemove={props.onPendingRemove}
						onRestore={props.onPendingRestore}
						onSendNow={props.onPendingSendNow}
					/>
					<InterfaceComposer
						allowSteering={allowSteering}
						inputs={props.iface.inputs}
						issues={props.issues}
						onAttachmentRemove={props.onAttachmentRemove}
						onFilesSelected={props.onFilesSelected}
						onMenuAction={props.onMenuAction}
						onStop={props.onStop}
						onSubmit={props.onSubmit}
						onVoiceClear={props.onVoiceClear}
						onVoiceStaged={props.onVoiceStaged}
						onTextChange={props.onDraftTextChange}
						pendingFiles={props.pendingFiles}
						pendingVoice={props.pendingVoice}
						phase={props.phase}
						text={props.draftText}
					/>
					<InterfaceGenerationSelect
						disabled={props.phase === 'streaming' || props.streaming}
						iface={props.iface}
						onGenerationChange={props.onGenerationChange}
						selectedEffort={props.selectedEffort}
						selectedModel={props.selectedModel}
					/>
				</div>
			</div>
		</div>
	);
}
