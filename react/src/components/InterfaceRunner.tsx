import type {
	ComposerPendingMessage,
	ComposerProfileInterface,
	ComposerRunPhase,
	TranscriptBlock,
} from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import '../styles/interface-runner.css';
import type { ComposerFieldHandlers } from './composer-field-handlers';
import { InterfaceRunnerComposer } from './InterfaceRunnerComposer';
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
	onGenerationChange?: (next: { modelId: string; effort?: string }) => void;
	selectedModel?: string;
	selectedEffort?: string;
} & ComposerFieldHandlers;

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
	const stageClass = [
		'iface-stage',
		chatStarted ? 'iface-stage--chat' : 'iface-stage--landing',
	].join(' ');

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

			<InterfaceRunnerComposer
				iface={iface}
				chatStarted={chatStarted}
				draftText={draftText}
				pendingFiles={pendingFiles}
				pendingVoice={pendingVoice}
				pendingMessages={pendingMessages}
				issues={issues}
				phase={phase}
				error={error}
				errorInternal={errorInternal}
				streaming={streaming}
				selectedModel={selectedModel}
				selectedEffort={selectedEffort}
				onGenerationChange={onGenerationChange}
				onPendingRemove={onPendingRemove}
				onPendingMove={onPendingMove}
				onPendingQueue={onPendingQueue}
				onPendingSendNow={onPendingSendNow}
				onPendingRestore={onPendingRestore}
				onDraftTextChange={onDraftTextChange}
				onFilesSelected={onFilesSelected}
				onAttachmentRemove={onAttachmentRemove}
				onVoiceStaged={onVoiceStaged}
				onVoiceClear={onVoiceClear}
				onSubmit={onSubmit}
				onStop={onStop}
				onMenuAction={onMenuAction}
			/>
		</section>
	);
}
