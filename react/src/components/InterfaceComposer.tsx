import { type ChangeEvent, type KeyboardEvent, useEffect, useState } from 'react';
import {
	type ComposerPrimaryAction,
	type ComposerRunPhase,
	type ProfileInputsInterface,
	resolveComposerMenuActions,
	resolveComposerPrimary,
	userDraftHasPayload,
} from '../../../src/interface/mod.ts';
import { stageComposerFiles } from '../client/composer-attachments';
import { isComposerExpanded } from '../client/composer-layout';
import { ComposerActionBar } from './ComposerActionBar';
import type { ComposerFieldHandlers } from './composer-field-handlers';
import { ComposerInputArea, ComposerIssues, ComposerShell } from './ComposerShell';
import { useComposerAttachmentPreviews } from './use-composer-attachment-previews';
import { useComposerMenuDismiss, useComposerShellLayout } from './use-composer-shell-layout';
import { useComposerVoice } from './use-composer-voice';

export type InterfaceComposerProps = {
	inputs: ProfileInputsInterface;
	text?: string;
	pendingFiles?: File[];
	pendingVoice?: File[];
	issues?: string[];
	/** Agent turn phase for send/stop/queue matrix. */
	phase?: ComposerRunPhase;
	/** Text profiles: show Steer in the menu while streaming. */
	allowSteering?: boolean;
	/** Host lock (e.g. live session not connected) — disables compose/send. */
	inputLocked?: boolean;
	onTextChange?: (value: string) => void;
} & Omit<ComposerFieldHandlers, 'onDraftTextChange'>;

function draftHasPayload(
	text: string,
	pendingFiles: readonly File[],
	pendingVoice: readonly File[],
): boolean {
	return userDraftHasPayload({
		...(text.trim() ? { text } : {}),
		...(pendingFiles.length
			? {
					attachments: pendingFiles.map((file) => ({
						name: file.name,
						mimeType: file.type || 'application/octet-stream',
						sizeBytes: file.size,
					})),
				}
			: {}),
		...(pendingVoice.length
			? {
					voice: pendingVoice.map((file) => ({
						name: file.name,
						mimeType: file.type || 'application/octet-stream',
						sizeBytes: file.size,
					})),
				}
			: {}),
	});
}

function primaryActionDisabled(args: {
	inputLocked: boolean;
	recording: boolean;
	primary: ComposerPrimaryAction;
	hasPayload: boolean;
}): boolean {
	const { inputLocked, recording, primary, hasPayload } = args;
	if (inputLocked || recording || primary === 'none') return true;
	if (primary === 'send' || primary === 'queue') return !hasPayload;
	return false;
}

function composerPlaceholder(
	recording: boolean,
	voiceCount: number,
	inputs: ProfileInputsInterface,
): string {
	if (recording) return 'Listening…';
	if (voiceCount > 0) return 'Voice ready — send or re-record';
	return `Message${inputs.attachments || inputs.voice ? ' or attach' : ''}…`;
}

function classNames(parts: Array<string | false | ''>): string {
	return parts.filter(Boolean).join(' ');
}

export function InterfaceComposer({
	inputs,
	text = '',
	pendingFiles = [],
	pendingVoice = [],
	issues = [],
	phase = 'idle',
	allowSteering = false,
	inputLocked = false,
	onTextChange,
	onFilesSelected,
	onAttachmentRemove,
	onVoiceStaged,
	onVoiceClear,
	onSubmit,
	onStop,
	onMenuAction,
}: InterfaceComposerProps) {
	const [attachNotice, setAttachNotice] = useState('');
	const [shellFocused, setShellFocused] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);

	const voiceEnabled = Boolean(inputs.voice);
	const attachmentCount = pendingFiles.length;
	const voiceCount = pendingVoice.length;

	const voice = useComposerVoice({
		inputs,
		pendingFiles,
		onVoiceStaged,
		onVoiceClear,
	});
	const recording = voice.recording;
	const expanded = isComposerExpanded(text.length, attachmentCount, voiceCount, recording);

	const hasPayload = draftHasPayload(text, pendingFiles, pendingVoice);
	const primary = resolveComposerPrimary({ phase, hasPayload, allowSteering });
	const menuActions = resolveComposerMenuActions({ phase, hasPayload, allowSteering });
	const primaryDisabled = primaryActionDisabled({
		inputLocked,
		recording,
		primary,
		hasPayload,
	});

	const { attachItems, revokeAllPreviews } = useComposerAttachmentPreviews(
		pendingFiles,
		pendingVoice,
	);
	const layout = useComposerShellLayout({
		text,
		recording,
		isExpanded: expanded,
		attachmentCount,
		voiceCount,
		attachItems,
	});
	const menuRef = useComposerMenuDismiss(menuOpen, setMenuOpen);

	useEffect(() => {
		layout.syncMaxHeight();
		const onResize = () => {
			layout.syncMaxHeight();
		};
		globalThis.addEventListener('resize', onResize);
		return () => {
			globalThis.removeEventListener('resize', onResize);
			voice.disposeRecorder();
			revokeAllPreviews();
		};
	}, [layout.syncMaxHeight, revokeAllPreviews, voice.disposeRecorder]);

	function handleAttachRemove(id: string) {
		setAttachNotice('');
		if (id === '__recording__' || id.startsWith('voice:')) {
			voice.discardRecordingOrVoice();
			return;
		}
		const match = /^file:(\d+):/.exec(id);
		if (!match) return;
		const index = Number(match[1]);
		if (!Number.isFinite(index)) return;
		onAttachmentRemove?.(index);
	}

	function runPrimary() {
		if (primaryDisabled) return;
		if (primary === 'stop') {
			onStop?.();
			return;
		}
		onSubmit?.();
	}

	function handleKeydown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			runPrimary();
		}
	}

	function handleFiles(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		const incoming = input.files ? [...input.files] : [];
		input.value = '';
		if (incoming.length === 0) return;

		const staged = stageComposerFiles({
			existing: pendingFiles,
			incoming,
			maxFiles: inputs.maxFiles,
			voiceCount: pendingVoice.length,
		});
		const added = staged.files.slice(pendingFiles.length);
		if (added.length > 0) onFilesSelected?.(added);
		setAttachNotice(staged.notice ?? '');
		if (staged.notice) voice.setVoiceError('');
	}

	return (
		<form
			className="iface-composer"
			onSubmit={(event) => {
				event.preventDefault();
				runPrimary();
			}}
		>
			<ComposerIssues
				issues={issues}
				attachNotice={attachNotice}
				voiceError={voice.voiceError}
			/>

			<ComposerShell
				shellRef={layout.shellRef}
				attachRowRef={layout.attachRowRef}
				shellFocused={shellFocused}
				recording={recording}
				inputLevel={voice.inputLevel}
				attachItems={attachItems}
				onAttachRemove={handleAttachRemove}
				onFocus={() => {
					setShellFocused(true);
				}}
				onBlur={(related, current) => {
					if (related instanceof Node && current.contains(related)) return;
					setShellFocused(false);
				}}
			>
				<ComposerInputArea
					inputs={inputs}
					text={text}
					recording={recording}
					inputLocked={inputLocked}
					expanded={expanded}
					voiceEnabled={voiceEnabled}
					voiceCount={voiceCount}
					placeholder={composerPlaceholder(recording, voiceCount, inputs)}
					innerClass={classNames([
						'iface-composer__inner',
						expanded ? 'iface-composer__inner--expanded' : 'iface-composer__inner--collapsed',
						inputs.attachments ? 'iface-composer__inner--has-attach' : '',
					])}
					inputClass={classNames([
						'iface-composer__input',
						!expanded ? 'iface-composer__input--single' : '',
					])}
					textareaRef={layout.textareaRef}
					innerRef={layout.innerRef}
					onKeyDown={handleKeydown}
					onTextChange={onTextChange}
					onFiles={handleFiles}
				>
					<ComposerActionBar
						voiceEnabled={voiceEnabled}
						recording={recording}
						inputLocked={inputLocked}
						streamingBusy={phase === 'streaming'}
						hasPayload={hasPayload}
						primary={primary}
						primaryDisabled={primaryDisabled}
						menuOpen={menuOpen}
						menuActions={menuActions}
						menuRef={menuRef}
						onToggleRecording={() => {
							void voice.toggleRecording();
						}}
						onToggleMenu={() => setMenuOpen((open) => !open)}
						onMenuAction={onMenuAction}
						setMenuOpen={setMenuOpen}
					/>
				</ComposerInputArea>
			</ComposerShell>
		</form>
	);
}
