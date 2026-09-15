import type { RefObject } from 'react';
import {
	IconChevronUp,
	IconLoader2,
	IconMicrophone,
	IconMicrophoneOff,
	IconPlayerStop,
	IconSend,
} from '@tabler/icons-react';
import type { ComposerMenuAction, ComposerPrimaryAction } from 'theorum/interface';
import {
	COMPOSER_MENU_ACTION_DESCRIPTIONS,
	COMPOSER_MENU_ACTION_LABELS,
	COMPOSER_PRIMARY_LABELS,
} from './composer-labels';

function ComposerPrimaryIcon(props: {
	primary: ComposerPrimaryAction;
	streamingBusy: boolean;
}) {
	if (props.primary === 'stop') {
		return (
			<span className="iface-composer__send-icon" aria-hidden="true">
				<IconPlayerStop size={18} stroke={1.75} />
			</span>
		);
	}
	if (props.streamingBusy && props.primary === 'none') {
		return (
			<span
				className="iface-composer__send-icon iface-composer__send-icon--spin"
				aria-hidden="true"
			>
				<IconLoader2 size={18} stroke={1.75} />
			</span>
		);
	}
	return (
		<span className="iface-composer__send-icon" aria-hidden="true">
			<IconSend size={18} stroke={1.75} />
		</span>
	);
}

function VoiceToggleButton(props: {
	recording: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			className={
				props.recording
					? 'iface-composer__voice iface-composer__voice--recording'
					: 'iface-composer__voice'
			}
			aria-label={props.recording ? 'Stop recording' : 'Record voice note'}
			disabled={props.disabled}
			onClick={props.onToggle}
			type="button"
		>
			{props.recording ? (
				<IconMicrophoneOff size={18} stroke={1.75} />
			) : (
				<IconMicrophone size={18} stroke={1.75} />
			)}
		</button>
	);
}

function sendTitle(primary: ComposerPrimaryAction): string {
	if (primary === 'queue') return 'Queue for after this turn';
	if (primary === 'stop') return 'Stop';
	return 'Send';
}

function OptionsMenu(props: {
	menuOpen: boolean;
	recording: boolean;
	inputLocked: boolean;
	menuActions: readonly ComposerMenuAction[];
	onToggleMenu: () => void;
	onMenuAction?: (action: ComposerMenuAction) => void;
	setMenuOpen: (open: boolean) => void;
}) {
	if (props.menuActions.length === 0) return null;
	return (
		<>
			<button
				aria-expanded={props.menuOpen}
				aria-haspopup="menu"
				aria-label="Message options"
				className="iface-composer__send-menu"
				disabled={props.recording || props.inputLocked}
				onClick={props.onToggleMenu}
				title="Message options: Queue, Steer, Send now, Stash"
				type="button"
			>
				<IconChevronUp size={14} stroke={2} />
			</button>
			{props.menuOpen ? (
				<ul className="iface-composer__menu" role="menu">
					{props.menuActions.map((action) => (
						<li key={action} role="none">
							<button
								className="iface-composer__menu-item"
								onClick={() => {
									props.setMenuOpen(false);
									props.onMenuAction?.(action);
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
	);
}

export function ComposerActionBar(props: {
	voiceEnabled: boolean;
	recording: boolean;
	inputLocked: boolean;
	streamingBusy: boolean;
	hasPayload: boolean;
	primary: ComposerPrimaryAction;
	primaryDisabled: boolean;
	menuOpen: boolean;
	menuActions: readonly ComposerMenuAction[];
	menuRef: RefObject<HTMLDivElement | null>;
	onToggleRecording: () => void;
	onToggleMenu: () => void;
	onMenuAction?: (action: ComposerMenuAction) => void;
	setMenuOpen: (open: boolean) => void;
}) {
	const showQueueLabel = props.primary === 'queue';
	const voiceDisabled = props.inputLocked || (props.streamingBusy && !props.hasPayload);

	return (
		<div className="iface-composer__actions">
			{props.voiceEnabled ? (
				<VoiceToggleButton
					recording={props.recording}
					disabled={voiceDisabled}
					onToggle={props.onToggleRecording}
				/>
			) : null}

			<div className="iface-composer__send-group" ref={props.menuRef}>
				<button
					className={
						showQueueLabel
							? 'iface-composer__send iface-composer__send--labeled'
							: 'iface-composer__send'
					}
					aria-label={COMPOSER_PRIMARY_LABELS[props.primary]}
					disabled={props.primaryDisabled}
					title={sendTitle(props.primary)}
					type="submit"
				>
					<ComposerPrimaryIcon
						primary={props.primary}
						streamingBusy={props.streamingBusy}
					/>
					{showQueueLabel ? <span className="iface-composer__send-label">Queue</span> : null}
				</button>
				<OptionsMenu
					menuOpen={props.menuOpen}
					recording={props.recording}
					inputLocked={props.inputLocked}
					menuActions={props.menuActions}
					onToggleMenu={props.onToggleMenu}
					onMenuAction={props.onMenuAction}
					setMenuOpen={props.setMenuOpen}
				/>
			</div>
		</div>
	);
}
