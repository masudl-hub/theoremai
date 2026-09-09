import {
	IconArrowDown,
	IconArrowUp,
	IconPlayerPlay,
	IconTrash,
	IconX,
} from '@tabler/icons-react';
import {
	type ComposerPendingKind,
	type ComposerPendingMessage,
	composerPendingPreview,
} from 'theorum/interface';

const KIND_LABEL: Record<ComposerPendingKind, string> = {
	steer: 'Steer',
	queue: 'Queue',
	stash: 'Stash',
};

export type ComposerPendingBarProps = {
	messages: readonly ComposerPendingMessage[];
	/** True while a turn stream is active — enables Send now (abort+send). */
	canSendNow?: boolean;
	onRemove?: (id: string) => void;
	onMove?: (id: string, direction: 'up' | 'down') => void;
	onSendNow?: (id: string) => void;
	onRestore?: (id: string) => void;
};

export function ComposerPendingBar({
	messages,
	canSendNow = false,
	onRemove,
	onMove,
	onSendNow,
	onRestore,
}: ComposerPendingBarProps) {
	if (messages.length === 0) return null;

	return (
		<ul className="iface-pending" aria-label="Pending messages">
			{messages.map((message) => {
				const preview = composerPendingPreview(message);
				const showSendNow = canSendNow && (message.kind === 'queue' || message.kind === 'steer');
				return (
					<li className="iface-pending__row" key={message.id}>
						<span className={`iface-pending__kind iface-pending__kind--${message.kind}`}>
							{KIND_LABEL[message.kind]}
						</span>
						<button
							className="iface-pending__preview"
							onClick={() => onRestore?.(message.id)}
							title="Edit in composer"
							type="button"
						>
							{preview || '(empty)'}
						</button>
						<div className="iface-pending__actions">
							{showSendNow ? (
								<button
									aria-label="Send now"
									className="iface-pending__btn"
									onClick={() => onSendNow?.(message.id)}
									title="Stop and send"
									type="button"
								>
									<IconPlayerPlay size={14} stroke={1.75} />
								</button>
							) : null}
							<button
								aria-label="Move up"
								className="iface-pending__btn"
								onClick={() => onMove?.(message.id, 'up')}
								type="button"
							>
								<IconArrowUp size={14} stroke={1.75} />
							</button>
							<button
								aria-label="Move down"
								className="iface-pending__btn"
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
