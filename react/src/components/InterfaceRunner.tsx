import type { ComposerProfileInterface, TranscriptBlock } from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import '../styles/interface-runner.css';
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
	issues?: string[];
	busy?: boolean;
	canSubmit?: boolean;
	/** Inline run error shown above the composer (never a page banner). */
	error?: string;
	onDraftTextChange?: (text: string) => void;
	onFilesSelected?: (files: File[]) => void;
	onAttachmentRemove?: (index: number) => void;
	onVoiceStaged?: (file: File) => void;
	onVoiceClear?: () => void;
	onSubmit?: () => void;
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
	issues = [],
	busy = false,
	canSubmit = false,
	error = '',
	onDraftTextChange,
	onFilesSelected,
	onAttachmentRemove,
	onVoiceStaged,
	onVoiceClear,
	onSubmit,
	onBranch,
	onToolDecision,
	onAuthCredential,
	selectedModel = '',
	selectedEffort = '',
	onGenerationChange,
}: InterfaceRunnerProps) {
	const displayBlocks = [...blocks, ...streamBlocks];
	const handleLabel = `@${iface.identity.handle}`;

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
							<p className="iface-inline-error" role="alert">
								{error}
							</p>
						) : null}
						<InterfaceComposer
							busy={busy}
							canSubmit={canSubmit}
							inputs={iface.inputs}
							issues={issues}
							onAttachmentRemove={onAttachmentRemove}
							onFilesSelected={onFilesSelected}
							onSubmit={onSubmit}
							onVoiceClear={onVoiceClear}
							onVoiceStaged={onVoiceStaged}
							onTextChange={onDraftTextChange}
							pendingFiles={pendingFiles}
							pendingVoice={pendingVoice}
							text={draftText}
						/>
						<InterfaceGenerationSelect
							disabled={busy || streaming}
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
