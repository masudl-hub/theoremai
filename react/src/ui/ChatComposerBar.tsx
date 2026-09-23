import { Badge } from '@astryxdesign/core/Badge';
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
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
	type ComposerMenuAction,
	type ComposerPendingMessage,
	type ComposerProfileInterface,
	type ComposerRunPhase,
	composerPendingPreview,
	effortSelectEnabled,
	interfaceEffortOptions,
	interfaceModelOptions,
	modelSelectEnabled,
	resolveComposerMenuActions,
	resolveComposerPrimary,
	userDraftHasPayload,
} from '../../../src/interface/mod.ts';
import { stageComposerFiles } from '../client/composer-attachments';
import {
	COMPOSER_MENU_ACTION_DESCRIPTIONS,
	COMPOSER_MENU_ACTION_LABELS,
} from '../components/composer-labels';
import { useComposerVoice } from '../components/use-composer-voice';

const NO_FOCUS_RING = { '--focus-outline-width': '0px' } as React.CSSProperties;

export type ChatComposerBarProps = {
	iface: ComposerProfileInterface;
	draftText: string;
	pendingFiles: readonly File[];
	pendingVoice: readonly File[];
	pendingMessages: readonly ComposerPendingMessage[];
	issues: readonly string[];
	phase: ComposerRunPhase;
	error: string;
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

const KIND_LABEL: Record<ComposerPendingMessage['kind'], string> = {
	steer: 'Steer',
	queue: 'Queued',
	stash: 'Stashed',
};

function fileSpecs(files: readonly File[]) {
	return files.map((file) => ({
		name: file.name,
		mimeType: file.type || 'application/octet-stream',
		sizeBytes: file.size,
	}));
}

/** Object URLs for image previews, revoked when the files change. */
function useImagePreviews(files: readonly File[]): (string | undefined)[] {
	const urls = useMemo(
		() => files.map((file) => (file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined)),
		[files],
	);
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
	const icon = (Glyph: typeof IconX) => <Glyph size={14} />;
	return (
		<HStack gap={1} align="center" width="100%">
			<Badge variant={message.kind === 'steer' ? 'info' : 'neutral'} label={KIND_LABEL[message.kind]} />
			<StackItem size="fill">
				<Text size="sm" maxLines={1} hasTruncateTooltip>
					{composerPendingPreview(message)}
				</Text>
			</StackItem>
			<HStack gap={0.5}>
				<IconButton label="Edit" tooltip="Edit" size="sm" variant="ghost" icon={icon(IconPencil)} onClick={() => props.onRestore(message.id)} />
				{message.kind === 'stash' ? (
					<IconButton label="Queue" tooltip="Queue" size="sm" variant="ghost" icon={icon(IconCornerDownLeft)} onClick={() => props.onQueue(message.id)} />
				) : null}
				<IconButton label="Send now" tooltip="Send now" size="sm" variant="ghost" icon={icon(IconSend)} onClick={() => props.onSendNow(message.id)} />
				<IconButton label="Move up" tooltip="Move up" size="sm" variant="ghost" icon={icon(IconArrowUp)} onClick={() => props.onMove(message.id, 'up')} />
				<IconButton label="Move down" tooltip="Move down" size="sm" variant="ghost" icon={icon(IconArrowDown)} onClick={() => props.onMove(message.id, 'down')} />
				<IconButton label="Remove" tooltip="Remove" size="sm" variant="ghost" icon={icon(IconX)} onClick={() => props.onRemove(message.id)} />
			</HStack>
		</HStack>
	);
}

function GenerationSelect(props: {
	iface: ComposerProfileInterface;
	selectedModel?: string;
	selectedEffort?: string;
	isDisabled: boolean;
	onChange: ChatComposerBarProps['onGenerationChange'];
}) {
	const models = modelSelectEnabled(props.iface) ? interfaceModelOptions(props.iface) : [];
	const efforts = effortSelectEnabled(props.iface, props.selectedModel)
		? interfaceEffortOptions(props.iface, props.selectedModel)
		: [];
	if (models.length === 0 && efforts.length === 0) return null;
	return (
		<HStack gap={1}>
			{models.length > 0 ? (
				<Selector
					label="Model"
					isLabelHidden
					size="sm"
					variant="ghost"
					startIcon={<IconCpu size={14} />}
					placement="above"
					isDisabled={props.isDisabled}
					value={props.selectedModel ?? ''}
					options={models.map((m) => ({ value: m.id, label: m.id, description: m.label !== m.id ? m.label : undefined }))}
					onChange={(modelId) => props.onChange({ modelId })}
				/>
			) : null}
			{efforts.length > 0 && props.selectedModel ? (
				<Selector
					label="Effort"
					isLabelHidden
					size="sm"
					variant="ghost"
					startIcon={<IconBrain size={14} />}
					placement="above"
					isDisabled={props.isDisabled}
					value={props.selectedEffort ?? ''}
					options={efforts.map((e) => ({ value: e.alias, label: e.alias, description: e.level }))}
					onChange={(effort) => {
						if (props.selectedModel) props.onChange({ modelId: props.selectedModel, effort });
					}}
				/>
			) : null}
		</HStack>
	);
}

function composerStatus(args: {
	error: string;
	issues: readonly string[];
	notice: string;
	voiceError: string;
}): ChatComposerStatus | undefined {
	if (args.error) return { type: 'error', message: args.error };
	const warning = [...args.issues, args.notice, args.voiceError].filter(Boolean).join(' ');
	return warning ? { type: 'warning', message: warning } : undefined;
}

/** Astryx composer wired to Theorem's send / stop / queue / steer / stash matrix. */
export function ChatComposerBar(props: ChatComposerBarProps) {
	const { iface, phase } = props;
	const inputs = iface.inputs;
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [notice, setNotice] = useState('');
	const pendingFiles = useMemo(() => [...props.pendingFiles], [props.pendingFiles]);
	const voice = useComposerVoice({
		inputs,
		pendingFiles,
		onVoiceStaged: props.onVoiceStaged,
		onVoiceClear: props.onVoiceClear,
	});
	const previews = useImagePreviews(props.pendingFiles);

	useEffect(() => () => voice.disposeRecorder(), [voice.disposeRecorder]);

	const allowSteering = 'allowSteering' in iface ? Boolean(iface.allowSteering) : false;
	const hasPayload = userDraftHasPayload({
		...(props.draftText.trim() ? { text: props.draftText } : {}),
		...(props.pendingFiles.length ? { attachments: fileSpecs(props.pendingFiles) } : {}),
		...(props.pendingVoice.length ? { voice: fileSpecs(props.pendingVoice) } : {}),
	});
	const primary = resolveComposerPrimary({ phase, hasPayload, allowSteering });
	const menuActions = resolveComposerMenuActions({ phase, hasPayload, allowSteering });
	const primaryDisabled =
		voice.recording || primary === 'none' || ((primary === 'send' || primary === 'queue') && !hasPayload);

	function runPrimary() {
		if (primaryDisabled) return;
		if (primary === 'stop') props.onStop();
		else props.onSubmit();
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
			voiceCount: props.pendingVoice.length,
		});
		const added = staged.files.slice(pendingFiles.length);
		if (added.length > 0) props.onFilesSelected(added);
		setNotice(staged.notice ?? '');
	}

	const drawerCount = props.pendingMessages.length + props.pendingFiles.length + props.pendingVoice.length;
	const drawer =
		drawerCount > 0 ? (
			<ChatComposerDrawer count={drawerCount} label="Pending">
				<VStack gap={2} width="100%">
					{props.pendingMessages.map((message) => (
						<PendingRow
							key={message.id}
							message={message}
							onMove={props.onPendingMove}
							onRemove={props.onPendingRemove}
							onQueue={props.onPendingQueue}
							onRestore={props.onPendingRestore}
							onSendNow={props.onPendingSendNow}
						/>
					))}
					{props.pendingFiles.length + props.pendingVoice.length > 0 ? (
						<HStack gap={2} wrap="wrap">
							{props.pendingFiles.map((file, index) =>
								previews[index] ? (
									<Thumbnail
										key={`${file.name}:${String(index)}`}
										src={previews[index]}
										alt={file.name}
										label={file.name}
										onRemove={() => props.onAttachmentRemove(index)}
									/>
								) : (
									<Token
										key={`${file.name}:${String(index)}`}
										label={file.name}
										onRemove={() => props.onAttachmentRemove(index)}
									/>
								),
							)}
							{props.pendingVoice.map((file) => (
								<Token
									key={`voice:${file.name}`}
									label="Voice note"
									icon={<IconMicrophone size={14} />}
									onRemove={() => voice.discardRecordingOrVoice()}
								/>
							))}
						</HStack>
					) : null}
				</VStack>
			</ChatComposerDrawer>
		) : undefined;

	const headerActions = inputs.attachments ? (
		<>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				hidden
				accept={inputs.attachments.acceptAttr}
				onChange={handleFiles}
			/>
			<IconButton
				label="Attach files"
				tooltip="Attach files"
				size="sm"
				variant="ghost"
				icon={<IconPaperclip size={16} />}
				onClick={() => fileInputRef.current?.click()}
			/>
		</>
	) : undefined;

	// Astryx: sendActions render to the left of the send button, at size="md".
	const sendActions =
		inputs.voice || menuActions.length > 0 ? (
			<>
				{menuActions.length > 0 ? (
					<DropdownMenu
						button={{
							label: 'More send options',
							isIconOnly: true,
							icon: <IconStack2 size={16} />,
							variant: 'ghost',
						}}
						hasChevron={false}
						placement="above"
						items={menuActions.map((action) => ({
							id: action,
							label: COMPOSER_MENU_ACTION_LABELS[action],
							description: COMPOSER_MENU_ACTION_DESCRIPTIONS[action],
							onClick: () => props.onMenuAction(action),
						}))}
					/>
				) : null}
				{inputs.voice ? (
					<IconButton
						label={voice.recording ? 'Stop recording' : 'Record voice'}
						tooltip={voice.recording ? 'Stop recording' : 'Record voice'}
						size="md"
						variant={voice.recording ? 'destructive' : 'ghost'}
						icon={voice.recording ? <IconPlayerRecordFilled size={16} /> : <IconMicrophone size={16} />}
						onClick={() => {
							void voice.toggleRecording();
						}}
					/>
				) : null}
			</>
		) : undefined;

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
			placeholder={
				voice.recording ? 'Listening…' : (props.placeholder ?? `Message @${iface.identity.handle}`)
			}
			input={<ChatComposerInput handleRef={props.inputRef} />}
			drawer={drawer}
			headerActions={headerActions}
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
				error: props.error,
				issues: props.issues,
				notice,
				voiceError: voice.voiceError,
			})}
		/>
	);
}
