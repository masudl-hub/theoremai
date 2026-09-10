import type {
	ComposerMenuAction,
	ComposerPendingMessage,
	ComposerProfileInterface,
	ComposerRunPhase,
	TranscriptBlock,
} from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import '../styles/interface-runner.css';
import { ComposerPendingBar } from './ComposerPendingBar';
import { InterfaceComposer } from './InterfaceComposer';
import { InterfaceGenerationSelect } from './InterfaceGenerationSelect';
import { InterfaceTranscript } from './InterfaceTranscript';

export type InterfaceRunnerProps = {
	iface: ComposerProfileInterface;
	blocks: TranscriptBlock[];
	streamBlocks?: TranscriptBlock[];
	streaming?: boolean;
	chatStarted?: boolean;
	draftText?: string;
	pendingFiles?: File[];
	pendingVoice?: File[];
	pendingMessages?: readonly ComposerPendingMessage[];
	issues?: string[];
	phase?: ComposerRunPhase;
	/** Inline run error shown above the composer (never a page banner). */
	error?: string;
	/** Optional diagnostic detail shown on hover of the public error. */
	errorInternal?: string;
	onDraftTextChange?: (text: string) => void;
	onFilesSelected?: (files: File[]) => void;
	onAttachmentRemove?: (index: number) => void;
	onVoiceStaged?: (file: File) => void;
	onVoiceClear?: () => void;
	onSubmit?: () => void;
	onStop?: () => void;
	onMenuAction?: (action: ComposerMenuAction) => void;
	onPendingRemove?: (id: string) => void;
	onPendingMove?: (id: string, direction: 'up' | 'down') => void;
	onPendingQueue?: (id: string) => void;
	onPendingSendNow?: (id: string) => void;
	onPendingRestore?: (id: string) => void;
	onBranch?: (index: number) => void;
	onToolDecision?: (
		index: number,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
	onAuthCredential?: (index: number, slot: string, credential: ToolCredential) => void;
	selectedModel?: string;
	selectedEffort?: string;
	onGenerationChange?: (next: { modelId: string; effort?: string }) => void;
};

export function InterfaceRunner({
	iface,
	blocks,
	streamBlocks = [],
	streaming = false,
	chatStarted = false,
	draftText = '',
	pendingFiles = [],
	pendingVoice = [],
	pendingMessages = [],
	issues = [],
	phase = 'idle',
	error = '',
	errorInternal = '',
	onDraftTextChange,
	onFilesSelected,
	onAttachmentRemove,
	onVoiceStaged,
	onVoiceClear,
	onSubmit,
	onStop,
	onMenuAction,
	onPendingRemove,
	onPendingMove,
	onPendingQueue,
	onPendingSendNow,
	onPendingRestore,
	onBranch,
	onToolDecision,
	onAuthCredential,
	selectedModel = '',
	selectedEffort = '',
	onGenerationChange,
}: InterfaceRunnerProps) {
	const displayBlocks = [...blocks, ...streamBlocks];
	const handleLabel = `@${iface.identity.handle}`;
	const allowSteering = 'allowSteering' in iface ? iface.allowSteering : false;

	const stageClass = [
		'iface-stage',
		chatStarted ? 'iface-stage--chat' : 'iface-stage--landing',
	].join(' ');

	const slotClass = ['iface-composer-slot', !chatStarted ? 'iface-composer-slot--landing' : '']
		.filter(Boolean)
		.join(' ');

	return (
		<section className={stageClass}>
			{chatStarted ? (
				<InterfaceTranscript
					blocks={displayBlocks}
					handle={iface.identity.handle}
					onAuthCredential={onAuthCredential}
					onBranch={onBranch}
					onToolDecision={onToolDecision}
					streaming={streaming}
				/>
			) : null}

			<div className="iface-rail">
				<div className={slotClass}>
					{!chatStarted ? (
						<header className="iface-head">
							<h1 className="iface-head__handle">{handleLabel}</h1>
						</header>
					) : null}

					<div className="iface-composer-wrap">
						{error ? (
							<div
								className={
									errorInternal
										? 'iface-inline-error iface-inline-error--detail'
										: 'iface-inline-error'
								}
								role="alert"
								tabIndex={errorInternal ? 0 : undefined}
							>
								<p className="iface-inline-error__public">{error}</p>
								{errorInternal ? (
									<pre className="iface-inline-error__internal">{errorInternal}</pre>
								) : null}
							</div>
						) : null}
						<ComposerPendingBar
							messages={pendingMessages}
							onMove={onPendingMove}
							onQueue={onPendingQueue}
							onRemove={onPendingRemove}
							onRestore={onPendingRestore}
							onSendNow={onPendingSendNow}
						/>
						<InterfaceComposer
							allowSteering={allowSteering}
							inputs={iface.inputs}
							issues={issues}
							onAttachmentRemove={onAttachmentRemove}
							onFilesSelected={onFilesSelected}
							onMenuAction={onMenuAction}
							onStop={onStop}
							onSubmit={onSubmit}
							onVoiceClear={onVoiceClear}
							onVoiceStaged={onVoiceStaged}
							onTextChange={onDraftTextChange}
							pendingFiles={pendingFiles}
							pendingVoice={pendingVoice}
							phase={phase}
							text={draftText}
						/>
						<InterfaceGenerationSelect
							disabled={phase === 'streaming' || streaming}
							iface={iface}
							onGenerationChange={onGenerationChange}
							selectedEffort={selectedEffort}
							selectedModel={selectedModel}
						/>
					</div>
				</div>
			</div>
		</section>
	);
}
