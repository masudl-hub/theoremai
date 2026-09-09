import {
	IconChevronUp,
	IconLoader2,
	IconMicrophone,
	IconMicrophoneOff,
	IconPlayerStop,
	IconPlus,
	IconSend,
} from '@tabler/icons-react';
import {
	type ChangeEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	COMPOSER_MENU_ACTION_DESCRIPTIONS,
	COMPOSER_MENU_ACTION_LABELS,
	COMPOSER_PRIMARY_LABELS,
	type ComposerMenuAction,
	type ComposerPrimaryAction,
	type ComposerRunPhase,
	type ProfileInputsInterface,
	resolveComposerMenuActions,
	resolveComposerPrimary,
	userDraftHasPayload,
} from 'theorum/interface';
import {
	composerShellHeight,
	isComposerExpanded,
	measureComposerTextareaHeight,
} from '../client/composer-layout';
import { ComposerVoiceRecorder, isVoiceRecorderFailure } from '../client/voice-recorder';
import { type ComposerAttachmentItem, ComposerAttachmentsRow } from './ComposerAttachmentsRow';

function fileAttachmentId(file: File, index: number): string {
	return `file:${String(index)}:${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}

function voiceAttachmentId(file: File, index: number): string {
	return `voice:${String(index)}:${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}

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
	onFilesSelected?: (files: File[]) => void;
	onAttachmentRemove?: (index: number) => void;
	onVoiceStaged?: (file: File) => void;
	onVoiceClear?: () => void;
	/** Primary action (Send / Queue) or Enter. */
	onSubmit?: () => void;
	onStop?: () => void;
	onMenuAction?: (action: ComposerMenuAction) => void;
};

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
	const [recording, setRecording] = useState(false);
	const [inputLevel, setInputLevel] = useState(0);
	const [voiceError, setVoiceError] = useState('');
	const [shellFocused, setShellFocused] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const recorderRef = useRef<ComposerVoiceRecorder | null>(null);
	const previewUrlsRef = useRef(new Map<string, string>());
	const [previewTick, setPreviewTick] = useState(0);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const voiceEnabled = Boolean(inputs.voice);
	const attachmentCount = pendingFiles.length;
	const voiceCount = pendingVoice.length;
	const isExpanded = isComposerExpanded(text.length, attachmentCount, voiceCount, recording);

	const hasPayload = userDraftHasPayload({
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

	const primary: ComposerPrimaryAction = resolveComposerPrimary({
		phase,
		hasPayload,
		allowSteering,
	});
	const menuActions = resolveComposerMenuActions({
		phase,
		hasPayload,
		allowSteering,
	});

	const primaryDisabled =
		inputLocked ||
		recording ||
		primary === 'none' ||
		(primary === 'send' && !hasPayload) ||
		(primary === 'queue' && !hasPayload);

	const attachItems = useMemo((): ComposerAttachmentItem[] => {
		const files: ComposerAttachmentItem[] = pendingFiles.map((file, index) => {
			const id = fileAttachmentId(file, index);
			return {
				id,
				kind: 'file',
				file,
				previewUrl: previewUrlsRef.current.get(id),
			};
		});
		const voices: ComposerAttachmentItem[] = pendingVoice.map((file, index) => ({
			id: voiceAttachmentId(file, index),
			kind: 'voice',
			file,
		}));
		return previewTick >= 0 ? [...files, ...voices] : [...files, ...voices];
	}, [pendingFiles, pendingVoice, previewTick]);

	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const innerRef = useRef<HTMLDivElement | null>(null);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const attachRowRef = useRef<HTMLDivElement | null>(null);
	const [maxHeight, setMaxHeight] = useState(320);
	const [contentHeight, setContentHeight] = useState(46);

	const shellHeight = composerShellHeight({ isExpanded, contentHeight });

	const syncMaxHeight = useCallback(() => {
		setMaxHeight(Math.round(window.innerHeight * 0.4));
	}, []);

	const revokeAllPreviews = useCallback(() => {
		for (const url of previewUrlsRef.current.values()) {
			URL.revokeObjectURL(url);
		}
		previewUrlsRef.current.clear();
	}, []);

	useEffect(() => {
		const keep: string[] = [];
		for (const [index, file] of pendingFiles.entries()) {
			if (!file.type.startsWith('image/')) continue;
			const id = fileAttachmentId(file, index);
			keep.push(id);
			if (!previewUrlsRef.current.has(id)) {
				previewUrlsRef.current.set(id, URL.createObjectURL(file));
			}
		}
		for (const id of [...previewUrlsRef.current.keys()]) {
			if (keep.includes(id)) continue;
			const url = previewUrlsRef.current.get(id);
			if (url) URL.revokeObjectURL(url);
			previewUrlsRef.current.delete(id);
		}
		setPreviewTick((v) => v + 1);
	}, [pendingFiles]);

	useEffect(() => {
		syncMaxHeight();
		const onResize = () => {
			syncMaxHeight();
		};
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			recorderRef.current?.dispose();
			revokeAllPreviews();
		};
	}, [revokeAllPreviews, syncMaxHeight]);

	useEffect(() => {
		if (!menuOpen) return;
		const onPointer = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			setMenuOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') setMenuOpen(false);
		};
		document.addEventListener('mousedown', onPointer);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onPointer);
			document.removeEventListener('keydown', onKey);
		};
	}, [menuOpen]);

	const layoutEpoch = `${String(text.length)}:${recording ? '1' : '0'}:${attachItems.map((item) => item.id).join('|')}`;

	useEffect(() => {
		const ta = textareaRef.current;
		if (!ta) return;
		if (layoutEpoch.length < 0) return;

		const scrollHeight = isExpanded
			? (() => {
					ta.style.height = 'auto';
					return ta.scrollHeight;
				})()
			: 0;
		const measured = measureComposerTextareaHeight({ scrollHeight, maxHeight, isExpanded });
		ta.style.height = `${String(measured.heightPx)}px`;
		ta.style.overflowY = measured.overflowY;

		const attachH = attachRowRef.current?.offsetHeight ?? 0;
		const innerH =
			isExpanded && innerRef.current
				? innerRef.current.offsetHeight + 2
				: measured.contentHeightFallback;
		setContentHeight(innerH + attachH);
	}, [layoutEpoch, isExpanded, maxHeight]);

	useEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		shell.style.height = `${String(shellHeight)}px`;
	}, [shellHeight]);

	function ensureRecorder(): ComposerVoiceRecorder {
		recorderRef.current ??= new ComposerVoiceRecorder(inputs.voice?.accept ?? [], (level) => {
			setInputLevel(level);
		});
		return recorderRef.current;
	}

	async function startRecording() {
		setVoiceError('');
		onVoiceClear?.();
		try {
			await ensureRecorder().start();
			setRecording(true);
		} catch (err) {
			setRecording(false);
			setVoiceError(
				isVoiceRecorderFailure(err)
					? err.message
					: err instanceof Error
						? err.message
						: 'Microphone unavailable',
			);
		}
	}

	async function stopRecording() {
		setVoiceError('');
		try {
			const file = await ensureRecorder().stop();
			setRecording(false);
			setInputLevel(0);
			onVoiceStaged?.(file);
		} catch (err) {
			setRecording(false);
			setInputLevel(0);
			setVoiceError(
				isVoiceRecorderFailure(err)
					? err.message
					: err instanceof Error
						? err.message
						: 'Recording failed',
			);
		}
	}

	async function toggleRecording() {
		if (recording) {
			await stopRecording();
			return;
		}
		await startRecording();
	}

	function discardRecordingOrVoice() {
		if (recording) {
			ensureRecorder().cancel();
			setRecording(false);
			setInputLevel(0);
		}
		onVoiceClear?.();
	}

	function handleAttachRemove(id: string) {
		if (id === '__recording__' || id.startsWith('voice:')) {
			discardRecordingOrVoice();
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
		const files = input.files ? [...input.files] : [];
		onFilesSelected?.(files);
		input.value = '';
	}

	const placeholder = recording
		? 'Listening…'
		: voiceCount > 0
			? 'Voice ready — send or re-record'
			: `Message${inputs.attachments || inputs.voice ? ' or attach' : ''}…`;

	const innerClass = [
		'iface-composer__inner',
		isExpanded ? 'iface-composer__inner--expanded' : 'iface-composer__inner--collapsed',
		inputs.attachments ? 'iface-composer__inner--has-attach' : '',
	]
		.filter(Boolean)
		.join(' ');

	const inputClass = [
		'iface-composer__input',
		!isExpanded ? 'iface-composer__input--collapsed' : '',
	]
		.filter(Boolean)
		.join(' ');

	const primaryLabel = COMPOSER_PRIMARY_LABELS[primary];
	const showQueueLabel = primary === 'queue';
	const streamingBusy = phase === 'streaming';

	return (
		<form
			className="iface-composer"
			onSubmit={(event) => {
				event.preventDefault();
				runPrimary();
			}}
		>
			{issues.length || voiceError ? (
				<ul className="iface-composer__issues" aria-live="polite">
					{issues.map((issue) => (
						<li key={issue}>{issue}</li>
					))}
					{voiceError ? <li>{voiceError}</li> : null}
				</ul>
			) : null}

			<div
				ref={shellRef}
				className={
					shellFocused
						? 'iface-composer__shell iface-composer__shell--focus'
						: 'iface-composer__shell'
				}
				onFocusCapture={() => {
					setShellFocused(true);
				}}
				onBlurCapture={(event) => {
					const next = event.relatedTarget;
					if (next instanceof Node && event.currentTarget.contains(next)) return;
					setShellFocused(false);
				}}
			>
				<div ref={attachRowRef}>
					<ComposerAttachmentsRow
						inputLevel={recording ? inputLevel : 0}
						items={attachItems}
						onRemove={handleAttachRemove}
						recording={recording}
					/>
				</div>

				<div className={innerClass} ref={innerRef}>
					{inputs.attachments ? (
						<label className="iface-composer__attach">
							<IconPlus size={18} stroke={1.75} aria-hidden="true" />
							<span className="sr-only">Attach file</span>
							<input
								accept={inputs.attachments.acceptAttr}
								className="iface-composer__file"
								disabled={recording || inputLocked}
								multiple={inputs.maxFiles !== 1}
								onChange={handleFiles}
								type="file"
							/>
						</label>
					) : null}

					{inputs.text ? (
						<textarea
							ref={textareaRef}
							className={inputClass}
							disabled={recording || inputLocked}
							onKeyDown={handleKeydown}
							onInput={(event) => onTextChange?.(event.currentTarget.value)}
							placeholder={isExpanded && !recording && voiceCount === 0 ? '' : placeholder}
							rows={1}
							value={text}
						/>
					) : voiceEnabled ? (
						<p className="iface-composer__voice-hint">
							{recording
								? 'Listening…'
								: voiceCount > 0
									? 'Voice ready — send'
									: 'tap mic to record'}
						</p>
					) : null}

					<div className="iface-composer__actions">
						{voiceEnabled ? (
							<button
								className={
									recording
										? 'iface-composer__voice iface-composer__voice--recording'
										: 'iface-composer__voice'
								}
								aria-label={recording ? 'Stop recording' : 'Record voice note'}
								disabled={inputLocked || (streamingBusy && !hasPayload)}
								onClick={() => {
									void toggleRecording();
								}}
								type="button"
							>
								{recording ? (
									<IconMicrophoneOff size={18} stroke={1.75} />
								) : (
									<IconMicrophone size={18} stroke={1.75} />
								)}
							</button>
						) : null}

						<div className="iface-composer__send-group" ref={menuRef}>
							<button
								className={
									showQueueLabel
										? 'iface-composer__send iface-composer__send--labeled'
										: 'iface-composer__send'
								}
								aria-label={primaryLabel}
								disabled={primaryDisabled}
								title={
									primary === 'queue'
										? 'Queue for after this turn'
										: primary === 'stop'
											? 'Stop'
											: 'Send'
								}
								type="submit"
							>
								{primary === 'stop' ? (
									<span className="iface-composer__send-icon" aria-hidden="true">
										<IconPlayerStop size={18} stroke={1.75} />
									</span>
								) : streamingBusy && primary === 'none' ? (
									<span
										className="iface-composer__send-icon iface-composer__send-icon--spin"
										aria-hidden="true"
									>
										<IconLoader2 size={18} stroke={1.75} />
									</span>
								) : (
									<span className="iface-composer__send-icon" aria-hidden="true">
										<IconSend size={18} stroke={1.75} />
									</span>
								)}
								{showQueueLabel ? (
									<span className="iface-composer__send-label">Queue</span>
								) : null}
							</button>
							{menuActions.length > 0 ? (
								<>
									<button
										aria-expanded={menuOpen}
										aria-haspopup="menu"
										aria-label="Message options"
										className="iface-composer__send-menu"
										disabled={recording || inputLocked}
										onClick={() => setMenuOpen((open) => !open)}
										title="Message options: Queue, Steer, Send now, Stash"
										type="button"
									>
										<IconChevronUp size={14} stroke={2} />
									</button>
									{menuOpen ? (
										<ul className="iface-composer__menu" role="menu">
											{menuActions.map((action) => (
												<li key={action} role="none">
													<button
														className="iface-composer__menu-item"
														onClick={() => {
															setMenuOpen(false);
															onMenuAction?.(action);
														}}
														role="menuitem"
														type="button"
													>
														<span className="iface-composer__menu-label">
															{COMPOSER_MENU_ACTION_LABELS[action]}
														</span>
														<span className="iface-composer__menu-desc">
															{COMPOSER_MENU_ACTION_DESCRIPTIONS[action]}
														</span>
													</button>
												</li>
											))}
										</ul>
									) : null}
								</>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</form>
	);
}
