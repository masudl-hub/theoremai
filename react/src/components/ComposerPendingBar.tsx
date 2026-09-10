import {
	IconArrowDown,
	IconArrowUp,
	IconTrash,
	IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import {
	type ComposerPendingKind,
	type ComposerPendingMessage,
	type PendingAttachment,
	composerPendingPreview,
} from 'theorum/interface';

const KIND_LABEL: Record<ComposerPendingKind, string> = {
	steer: 'Steer',
	queue: 'Queue',
	stash: 'Stash',
};

export type ComposerPendingBarProps = {
	messages: readonly ComposerPendingMessage[];
	onRemove?: (id: string) => void;
	onMove?: (id: string, direction: 'up' | 'down') => void;
	/** Promote stash → queue (and drain when idle). */
	onQueue?: (id: string) => void;
	/** Abort current run if needed and send this pending draft now. */
	onSendNow?: (id: string) => void;
	/** Load draft (text + attachments + voice) back into the composer. */
	onRestore?: (id: string) => void;
};

function isImageMime(mime: string): boolean {
	return mime.toLowerCase().startsWith('image/');
}

function isAudioMime(mime: string): boolean {
	return mime.toLowerCase().startsWith('audio/');
}

function attachmentPreviewSrc(attachment: PendingAttachment): string | null {
	if (typeof attachment.data !== 'string' || attachment.data.length === 0) return null;
	return `data:${attachment.mimeType || 'application/octet-stream'};base64,${attachment.data}`;
}

function PendingThumb({
	attachment,
	kind,
	onRestore,
}: {
	attachment: PendingAttachment;
	kind: 'file' | 'voice';
	onRestore?: () => void;
}) {
	const src = attachmentPreviewSrc(attachment);
	const image = kind === 'file' && isImageMime(attachment.mimeType);
	const audio = kind === 'voice' || isAudioMime(attachment.mimeType);

	if (image && src) {
		return (
			<button
				className="iface-pending__thumb iface-pending__thumb--image"
				onClick={() => onRestore?.()}
				title={attachment.name}
				type="button"
			>
				<img alt="" draggable={false} src={src} />
			</button>
		);
	}

	if (audio && src) {
		return <PendingAudioThumb name={attachment.name} src={src} />;
	}

	return (
		<button
			className="iface-pending__thumb iface-pending__thumb--file"
			onClick={() => onRestore?.()}
			title={attachment.name}
			type="button"
		>
			{attachment.name}
		</button>
	);
}

function PendingAudioThumb({ name, src }: { name: string; src: string }) {
	const [playing, setPlaying] = useState(false);

	return (
		<button
			aria-label={playing ? `Pause ${name}` : `Play ${name}`}
			className={[
				'iface-pending__thumb',
				'iface-pending__thumb--voice',
				playing ? 'iface-pending__thumb--playing' : '',
			]
				.filter(Boolean)
				.join(' ')}
			onClick={(event) => {
				event.stopPropagation();
				const audio = event.currentTarget.querySelector('audio');
				if (!audio) return;
				if (audio.paused) {
					void audio.play().catch(() => {
						setPlaying(false);
					});
				} else {
					audio.pause();
				}
			}}
			title={playing ? 'Pause' : 'Play'}
			type="button"
		>
			<audio
				onEnded={() => {
					setPlaying(false);
				}}
				onPause={() => {
					setPlaying(false);
				}}
				onPlay={() => {
					setPlaying(true);
				}}
				preload="metadata"
				src={src}
			/>
			<span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
		</button>
	);
}

export function ComposerPendingBar({
	messages,
	onRemove,
	onMove,
	onQueue,
	onSendNow,
	onRestore,
}: ComposerPendingBarProps) {
	const kindCounts = useMemo(() => {
		const counts: Record<ComposerPendingKind, number> = { steer: 0, queue: 0, stash: 0 };
		for (const message of messages) counts[message.kind] += 1;
		return counts;
	}, [messages]);

	const kindIndexes = useMemo(() => {
		const seen: Record<ComposerPendingKind, number> = { steer: 0, queue: 0, stash: 0 };
		const map = new Map<string, number>();
		for (const message of messages) {
			map.set(message.id, seen[message.kind]);
			seen[message.kind] += 1;
		}
		return map;
	}, [messages]);

	if (messages.length === 0) return null;

	return (
		<ul className="iface-pending" aria-label="Pending messages">
			{messages.map((message) => {
				const preview = composerPendingPreview(message);
				const attachments = message.draft.attachments ?? [];
				const voice = message.draft.voice ?? [];
				const indexInKind = kindIndexes.get(message.id) ?? 0;
				const countInKind = kindCounts[message.kind];
				const canQueue = message.kind === 'stash';

				return (
					<li className="iface-pending__row" key={message.id}>
						<span className={`iface-pending__kind iface-pending__kind--${message.kind}`}>
							{KIND_LABEL[message.kind]}
						</span>
						<div className="iface-pending__body">
							{(attachments.length > 0 || voice.length > 0) && (
								<span className="iface-pending__thumbs">
									{attachments.map((attachment, index) => (
										<PendingThumb
											attachment={attachment}
											key={`file-${String(index)}-${attachment.name}`}
											kind="file"
											onRestore={() => onRestore?.(message.id)}
										/>
									))}
									{voice.map((attachment, index) => (
										<PendingThumb
											attachment={attachment}
											key={`voice-${String(index)}-${attachment.name}`}
											kind="voice"
										/>
									))}
								</span>
							)}
							<button
								className="iface-pending__preview"
								onClick={() => onRestore?.(message.id)}
								title="Edit in composer"
								type="button"
							>
								{preview || '(empty)'}
							</button>
						</div>
						<div className="iface-pending__actions">
							{canQueue ? (
								<button
									className="iface-pending__action"
									onClick={() => onQueue?.(message.id)}
									title="Queue for after this turn"
									type="button"
								>
									Queue
								</button>
							) : null}
							<button
								className="iface-pending__action"
								onClick={() => onSendNow?.(message.id)}
								title="Send now"
								type="button"
							>
								Send now
							</button>
							<button
								aria-label="Move up"
								className="iface-pending__btn"
								disabled={indexInKind === 0}
								onClick={() => onMove?.(message.id, 'up')}
								type="button"
							>
								<IconArrowUp size={14} stroke={1.75} />
							</button>
							<button
								aria-label="Move down"
								className="iface-pending__btn"
								disabled={indexInKind >= countInKind - 1}
								onClick={() => onMove?.(message.id, 'down')}
								type="button"
							>
								<IconArrowDown size={14} stroke={1.75} />
							</button>
							<button
								aria-label="Remove"
								className="iface-pending__btn"
								onClick={() => onRemove?.(message.id)}
								type="button"
							>
								{message.kind === 'stash' ? (
									<IconX size={14} stroke={1.75} />
								) : (
									<IconTrash size={14} stroke={1.75} />
								)}
							</button>
						</div>
					</li>
				);
			})}
		</ul>
	);
}
