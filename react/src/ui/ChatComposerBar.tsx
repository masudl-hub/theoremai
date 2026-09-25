import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import {
	ChatComposer,
	ChatComposerDrawer,
	ChatComposerInput,
	type ChatComposerInputHandle,
	type ChatComposerStatus,
	ChatSendButton,
} from '@astryxdesign/core/Chat';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import {
	IconArrowDown,
	IconArrowUp,
	IconBrain,
	IconCornerDownLeft,
	IconCpu,
	IconMicrophone,
	IconPaperclip,
	IconPencil,
	IconPlayerRecordFilled,
	IconSend,
	IconStack2,
	IconX,
} from '@tabler/icons-react';
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { attachmentIssueText, type LexiconOverrides } from '../../../mod.ts';
import {
	type AttachmentValidationIssue,
	type ComposerMenuAction,
	type ComposerPendingMessage,
	type ComposerProfileInterface,
	type ComposerRunPhase,
	composerPendingPreview,
	effortSelectEnabled,
	interfaceEffortOptions,
	interfaceModelOptions,
	modelSelectEnabled,
} from '../../../src/interface/mod.ts';
import { stageComposerFiles } from '../client/composer-attachments';
import { composerActionState } from '../client/composer-primary';
import { type ComposerDrawerSummary, composerDrawerSummary } from '../client/composer-drawer';
import {
	type ComposerHint as ComposerHintData,
	isStashShortcut,
	resolveComposerHint,
	STASH_SHORTCUT,
} from '../client/composer-hints';
import type { ClientFailure } from '../client/failure';
import { useComposerVoice, type VoiceFailure } from '../components/use-composer-voice';
import { composerDrawerLabel } from './labels';
import { TheoremLabelsProvider, useLabels } from './labels-provider';
import { VoiceNote } from './VoiceNote';
import { useEditorSelection } from '../components/use-editor-selection';

export const NO_FOCUS_RING = { '--focus-outline-width': '0px' } as React.CSSProperties;

export type ChatComposerBarProps = {
	iface: ComposerProfileInterface;
	draftText: string;
	pendingFiles: readonly File[];
	pendingVoice: readonly File[];
	pendingMessages: readonly ComposerPendingMessage[];
	/** Files the last send refused, one per reason; worded with the profile's lexicon. */
	issues: readonly AttachmentValidationIssue[];
	phase: ComposerRunPhase;
	failure: ClientFailure | null;
	selectedModel?: string;
	selectedEffort?: string;
	placeholder?: string;
	/** Imperative handle for the editor (focus, insert). */
	inputRef?: React.Ref<ChatComposerInputHandle>;
	onDraftTextChange: (text: string) => void;
	onFilesSelected: (files: File[]) => void;
	onAttachmentRemove: (index: number) => void;
	onVoiceStaged: (file: File) => void;
	onVoiceClear: () => void;
	onSubmit: () => void;
	onStop: () => void;
	onMenuAction: (action: ComposerMenuAction) => void;
	onGenerationChange: (next: { modelId: string; effort?: string }) => void;
	onPendingMove: (id: string, direction: 'up' | 'down') => void;
	onPendingRemove: (id: string) => void;
	onPendingQueue: (id: string) => void;
	onPendingRestore: (id: string) => void;
	onPendingSendNow: (id: string) => void;
};

const isImage = (file: File) => file.type.startsWith('image/');
const anyFile = () => true;

/** Object URLs for the files `keep` (a module-level predicate) accepts, revoked when the files change. */
function useObjectUrls(files: readonly File[], keep: (file: File) => boolean): (string | undefined)[] {
	const urls = useMemo(() => files.map((file) => (keep(file) ? URL.createObjectURL(file) : undefined)), [files, keep]);
	useEffect(
		() => () => {
			for (const url of urls) if (url) URL.revokeObjectURL(url);
		},
		[urls],
	);
	return urls;
}

function PendingRow(props: {
	message: ComposerPendingMessage;
	onMove: ChatComposerBarProps['onPendingMove'];
	onRemove: ChatComposerBarProps['onPendingRemove'];
	onQueue: ChatComposerBarProps['onPendingQueue'];
	onRestore: ChatComposerBarProps['onPendingRestore'];
	onSendNow: ChatComposerBarProps['onPendingSendNow'];
}) {
	const { message } = props;
	const t = useLabels();
	const icon = (Glyph: typeof IconX) => <Glyph size={14} />;
	const edit = t('@theorem.composer.pending.edit');
	const queue = t('@theorem.composer.pending.queue_action');
	const sendNow = t('@theorem.composer.pending.send_now');
	const moveUp = t('@theorem.composer.pending.move_up');
	const moveDown = t('@theorem.composer.pending.move_down');
	const remove = t('@theorem.composer.pending.remove');
	return (
		<HStack gap={1} align="center" width="100%">
			<Badge
				variant={message.kind === 'steer' ? 'info' : 'neutral'}
				label={t(`@theorem.composer.pending.${message.kind}`)}
			/>
			<StackItem size="fill">
				<Text size="sm" maxLines={1} hasTruncateTooltip>
					{composerPendingPreview(message)}
				</Text>
			</StackItem>
			<HStack gap={0.5}>
				<IconButton label={edit} tooltip={edit} size="sm" variant="ghost" icon={icon(IconPencil)} onClick={() => props.onRestore(message.id)} />
				{message.kind === 'stash' ? (
					<IconButton label={queue} tooltip={queue} size="sm" variant="ghost" icon={icon(IconCornerDownLeft)} onClick={() => props.onQueue(message.id)} />
				) : null}
				<IconButton label={sendNow} tooltip={sendNow} size="sm" variant="ghost" icon={icon(IconSend)} onClick={() => props.onSendNow(message.id)} />
				<IconButton label={moveUp} tooltip={moveUp} size="sm" variant="ghost" icon={icon(IconArrowUp)} onClick={() => props.onMove(message.id, 'up')} />
				<IconButton label={moveDown} tooltip={moveDown} size="sm" variant="ghost" icon={icon(IconArrowDown)} onClick={() => props.onMove(message.id, 'down')} />
				<IconButton label={remove} tooltip={remove} size="sm" variant="ghost" icon={icon(IconX)} onClick={() => props.onRemove(message.id)} />
			</HStack>
		</HStack>
	);
}

type ModelOption = ReturnType<typeof interfaceModelOptions>[number];
type EffortOption = ReturnType<typeof interfaceEffortOptions>[number];

/** The model and effort choices this profile offers; efforts only for a chosen model. */
function generationOptions(iface: ComposerProfileInterface, selectedModel?: string) {
	const models = modelSelectEnabled(iface) ? interfaceModelOptions(iface) : [];
	const efforts =
		selectedModel && effortSelectEnabled(iface, selectedModel) ? interfaceEffortOptions(iface, selectedModel) : [];
	return { models, efforts };
}

function ModelSelector(props: {
	models: readonly ModelOption[];
	value?: string;
	isDisabled: boolean;
	onChange: (modelId: string) => void;
}) {
	const t = useLabels();
	if (props.models.length === 0) return null;
	return (
		<Selector
			label={t('@theorem.composer.model')}
			isLabelHidden
			size="sm"
			variant="ghost"
			startIcon={<IconCpu size={14} />}
			placement="above"
			isDisabled={props.isDisabled}
			value={props.value ?? ''}
			options={props.models.map((m) => ({ value: m.id, label: m.id, description: m.label !== m.id ? m.label : undefined }))}
			onChange={props.onChange}
		/>
	);
}

function EffortSelector(props: {
	efforts: readonly EffortOption[];
	value?: string;
	isDisabled: boolean;
	onChange: (effort: string) => void;
}) {
	const t = useLabels();
	if (props.efforts.length === 0) return null;
	return (
		<Selector
			label={t('@theorem.composer.effort')}
			isLabelHidden
			size="sm"
			variant="ghost"
			startIcon={<IconBrain size={14} />}
			placement="above"
			isDisabled={props.isDisabled}
			value={props.value ?? ''}
			options={props.efforts.map((e) => ({ value: e.alias, label: e.alias, description: e.level }))}
			onChange={props.onChange}
		/>
	);
}

function GenerationSelect(props: {
	iface: ComposerProfileInterface;
	selectedModel?: string;
	selectedEffort?: string;
	isDisabled: boolean;
	onChange: ChatComposerBarProps['onGenerationChange'];
}) {
	const { models, efforts } = generationOptions(props.iface, props.selectedModel);
	if (models.length + efforts.length === 0) return null;
	return (
		<HStack gap={1}>
			<ModelSelector
				models={models}
				value={props.selectedModel}
				isDisabled={props.isDisabled}
				onChange={(modelId) => props.onChange({ modelId })}
			/>
			<EffortSelector
				efforts={efforts}
				value={props.selectedEffort}
				isDisabled={props.isDisabled}
				onChange={(effort) => {
					if (props.selectedModel) props.onChange({ modelId: props.selectedModel, effort });
				}}
			/>
		</HStack>
	);
}

function composerStatus(args: {
	failure: ClientFailure | null;
	issues: readonly AttachmentValidationIssue[];
	voiceFailure: VoiceFailure | null;
	lexicon: LexiconOverrides;
}): ChatComposerStatus | undefined {
	if (args.failure) return { type: 'error', message: args.failure.error };
	const warning = [
		...args.issues.map((issue) => attachmentIssueText(issue, args.lexicon)),
		args.voiceFailure?.error,
	]
		.filter(Boolean)
		.join(' ');
	return warning ? { type: 'warning', message: warning } : undefined;
}

type StagedFile = { file: File; index: number; preview?: string };

/** Pending messages, then two uniform rows: 64px tiles (images, voice notes), then file tokens. */
function PendingDrawer(props: {
	summary: ComposerDrawerSummary;
	messages: readonly ComposerPendingMessage[];
	imageFiles: readonly StagedFile[];
	otherFiles: readonly StagedFile[];
	voiceFiles: readonly File[];
	voiceUrls: readonly (string | undefined)[];
	pendingActions: Omit<Parameters<typeof PendingRow>[0], 'message'>;
	onAttachmentRemove: (index: number) => void;
	onVoiceRemove: () => void;
}) {
	const t = useLabels();
	return (
		<ChatComposerDrawer count={props.summary.count} label={composerDrawerLabel(t, props.summary)}>
			<VStack gap={2} width="100%">
				{props.messages.map((message) => (
					<PendingRow key={message.id} message={message} {...props.pendingActions} />
				))}
				{props.imageFiles.length + props.voiceFiles.length > 0 ? (
					<HStack gap={2} wrap="wrap" vAlign="center">
						{props.imageFiles.map(({ file, index, preview }) => (
							<Thumbnail
								key={`${file.name}:${String(index)}`}
								src={preview}
								alt={file.name}
								label={file.name}
								onRemove={() => props.onAttachmentRemove(index)}
							/>
						))}
						{props.voiceFiles.map((file, index) => (
							<VoiceNote
								key={`voice:${file.name}`}
								src={props.voiceUrls[index] ?? ''}
								mimeType={file.type || undefined}
								onRemove={props.onVoiceRemove}
							/>
						))}
					</HStack>
				) : null}
				{props.otherFiles.length > 0 ? (
					<HStack gap={2} wrap="wrap">
						{props.otherFiles.map(({ file, index }) => (
							<Token
								key={`${file.name}:${String(index)}`}
								label={file.name}
								onRemove={() => props.onAttachmentRemove(index)}
							/>
						))}
					</HStack>
				) : null}
			</VStack>
		</ChatComposerDrawer>
	);
}

/** A hidden file input behind the paperclip button. */
function AttachFilesButton({ accept, onFiles }: { accept?: string; onFiles: (files: File[]) => void }) {
	const t = useLabels();
	const label = t('@theorem.composer.attach');
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		const incoming = input.files ? [...input.files] : [];
		input.value = '';
		if (incoming.length > 0) onFiles(incoming);
	}
	return (
		<>
			<input ref={fileInputRef} type="file" multiple hidden accept={accept} onChange={handleChange} />
			<IconButton
				label={label}
				tooltip={label}
				size="sm"
				variant="ghost"
				icon={<IconPaperclip size={16} />}
				onClick={() => fileInputRef.current?.click()}
			/>
		</>
	);
}

function SendMenu({ actions, onAction }: { actions: readonly ComposerMenuAction[]; onAction: (action: ComposerMenuAction) => void }) {
	const t = useLabels();
	if (actions.length === 0) return null;
	return (
		<DropdownMenu
			button={{
				label: t('@theorem.composer.send_options'),
				isIconOnly: true,
				icon: <IconStack2 size={16} />,
				variant: 'ghost',
			}}
			hasChevron={false}
			placement="above"
			items={actions.map((action) => ({
				id: action,
				label: t(`@theorem.composer.menu.${action}`),
				description: t(`@theorem.composer.menu.${action}.description`),
				...(action === 'stash' ? { endContent: <Kbd keys={STASH_SHORTCUT} /> } : {}),
				onClick: () => onAction(action),
			}))}
		/>
	);
}

function RecordButton({ recording, onToggle }: { recording: boolean; onToggle: () => void }) {
	const t = useLabels();
	const label = t(recording ? '@theorem.composer.stop_recording' : '@theorem.composer.record');
	return (
		<IconButton
			label={label}
			tooltip={label}
			size="md"
			variant={recording ? 'destructive' : 'ghost'}
			icon={recording ? <IconPlayerRecordFilled size={16} /> : <IconMicrophone size={16} />}
			onClick={onToggle}
		/>
	);
}

/** Astryx's slot for contextual info (header, right side). */
function ComposerHint({ hint, onAction }: { hint: ComposerHintData; onAction: () => void }) {
	const t = useLabels();
	return (
		<HStack gap={2} vAlign="center">
			<Text size="sm" color="secondary">
				{t(`@theorem.composer.hint.${hint.id}.message`)}
			</Text>
			<Button label={t(`@theorem.composer.hint.${hint.id}.action`)} size="sm" variant="ghost" onClick={onAction} />
			<Kbd keys={hint.shortcut} />
		</HStack>
	);
}

/** Staged files split into image tiles and file tokens, with object URLs for previews and voice notes. */
function useStagedFiles(pendingFiles: readonly File[], pendingVoice: readonly File[]) {
	const previews = useObjectUrls(pendingFiles, isImage);
	const voiceUrls = useObjectUrls(pendingVoice, anyFile);
	const staged: StagedFile[] = pendingFiles.map((file, index) => ({ file, index, preview: previews[index] }));
	return {
		imageFiles: staged.filter((entry) => entry.preview !== undefined),
		otherFiles: staged.filter((entry) => entry.preview === undefined),
		voiceUrls,
	};
}

/** Astryx composer wired to Theorem's send / stop / queue / steer / stash matrix. */
export function ChatComposerBar(props: ChatComposerBarProps) {
	return (
		<TheoremLabelsProvider>
			<ChatComposerBarBody {...props} />
		</TheoremLabelsProvider>
	);
}

function ChatComposerBarBody(props: ChatComposerBarProps) {
	const { iface, phase } = props;
	const t = useLabels();
	const inputs = iface.inputs;
	const [stagingIssues, setStagingIssues] = useState<AttachmentValidationIssue[]>([]);
	const pendingFiles = useMemo(() => [...props.pendingFiles], [props.pendingFiles]);
	const voice = useComposerVoice({
		inputs,
		lexicon: iface.lexicon,
		pendingFiles,
		onVoiceStaged: props.onVoiceStaged,
		onVoiceClear: props.onVoiceClear,
	});
	const stagedFiles = useStagedFiles(props.pendingFiles, props.pendingVoice);

	useEffect(() => () => voice.disposeRecorder(), [voice.disposeRecorder]);

	const { primary, menuActions, primaryDisabled } = composerActionState({
		iface,
		phase,
		draftText: props.draftText,
		pendingFiles: props.pendingFiles,
		pendingVoice: props.pendingVoice,
		recording: voice.recording,
	});
	const canStash = menuActions.includes('stash');
	const editorRef = useRef<HTMLDivElement | null>(null);
	const hint = resolveComposerHint({
		draftText: props.draftText,
		selectedText: useEditorSelection(editorRef),
		canStash,
	});

	function runPrimary() {
		if (primaryDisabled) return;
		if (primary === 'stop') props.onStop();
		else props.onSubmit();
	}

	function stageFiles(incoming: File[]) {
		const staged = stageComposerFiles({
			existing: pendingFiles,
			incoming,
			maxFiles: inputs.maxFiles,
			voiceCount: props.pendingVoice.length,
		});
		const added = staged.files.slice(pendingFiles.length);
		if (added.length > 0) props.onFilesSelected(added);
		setStagingIssues(staged.issues);
	}

	const drawerSummary = composerDrawerSummary({
		pendingMessages: props.pendingMessages,
		attachmentCount: props.pendingFiles.length + props.pendingVoice.length,
	});
	const drawer = drawerSummary ? (
		<PendingDrawer
			summary={drawerSummary}
			messages={props.pendingMessages}
			{...stagedFiles}
			voiceFiles={props.pendingVoice}
			pendingActions={{
				onMove: props.onPendingMove,
				onRemove: props.onPendingRemove,
				onQueue: props.onPendingQueue,
				onRestore: props.onPendingRestore,
				onSendNow: props.onPendingSendNow,
			}}
			onAttachmentRemove={props.onAttachmentRemove}
			onVoiceRemove={() => voice.discardRecordingOrVoice()}
		/>
	) : undefined;

	// Astryx: sendActions render to the left of the send button, at size="md".
	const sendActions: ReactNode = (
		<>
			<SendMenu actions={menuActions} onAction={props.onMenuAction} />
			{inputs.voice ? <RecordButton recording={voice.recording} onToggle={() => void voice.toggleRecording()} /> : null}
		</>
	);
	const placeholder = props.placeholder ?? t('@theorem.composer.placeholder', { handle: iface.identity.handle });

	return (
		<ChatComposer
			// No keyboard focus ring on the composer (product choice): zero Astryx's
			// focus-outline token for this subtree. The editor still shows its caret.
			style={NO_FOCUS_RING}
			value={props.draftText}
			onChange={props.onDraftTextChange}
			onSubmit={runPrimary}
			onStop={props.onStop}
			isStopShown={primary === 'stop'}
			placeholder={voice.recording ? t('@theorem.composer.listening') : placeholder}
			input={
				<ChatComposerInput
					ref={editorRef}
					handleRef={props.inputRef}
					onKeyDown={(event) => {
						// Seance's stash shortcut: only while the composer is focused.
						if (!isStashShortcut(event)) return;
						event.preventDefault();
						if (canStash) props.onMenuAction('stash');
					}}
				/>
			}
			drawer={drawer}
			headerActions={
				inputs.attachments ? <AttachFilesButton accept={inputs.attachments.acceptAttr} onFiles={stageFiles} /> : undefined
			}
			headerContext={hint ? <ComposerHint hint={hint} onAction={() => props.onMenuAction('stash')} /> : undefined}
			footerActions={
				<GenerationSelect
					iface={iface}
					selectedModel={props.selectedModel}
					selectedEffort={props.selectedEffort}
					isDisabled={phase === 'streaming'}
					onChange={props.onGenerationChange}
				/>
			}
			sendActions={sendActions}
			sendButton={
				<ChatSendButton
					isStopShown={primary === 'stop'}
					isDisabled={primaryDisabled}
					onSend={runPrimary}
					onStop={props.onStop}
				/>
			}
			status={composerStatus({
				failure: props.failure,
				issues: [...props.issues, ...stagingIssues],
				voiceFailure: voice.failure,
				lexicon: iface.lexicon,
			})}
		/>
	);
}
