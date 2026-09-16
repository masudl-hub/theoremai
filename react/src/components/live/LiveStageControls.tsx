import {
	IconCameraRotate,
	IconMessage,
	IconMicrophone,
	IconMicrophoneOff,
	IconPhone,
	IconPhoneOff,
	IconVideo,
	IconVideoOff,
} from '@tabler/icons-react';
import { InkTooltip } from '../InkTooltip';

export type LiveStageControlsProps = {
	voiceAvailable: boolean;
	videoAvailable: boolean;
	textAvailable: boolean;
	isMuted: boolean;
	isVideoOn: boolean;
	textComposerOpen: boolean;
	sessionActive: boolean;
	canRestart: boolean;
	onToggleMic?: () => void;
	onToggleVideo?: () => void;
	onFlipCamera?: () => void;
	onToggleTextComposer?: () => void;
	onRestart?: () => void;
	onEnd?: () => void;
};

export function LiveStageControls({
	voiceAvailable,
	videoAvailable,
	textAvailable,
	isMuted,
	isVideoOn,
	textComposerOpen,
	sessionActive,
	canRestart,
	onToggleMic,
	onToggleVideo,
	onFlipCamera,
	onToggleTextComposer,
	onRestart,
	onEnd,
}: LiveStageControlsProps) {
	return (
		<div className="ink-controls">
			<div className="ink-controls__left">
				{voiceAvailable ? (
					<InkTooltip label={isMuted ? 'open mic' : 'close mic'}>
						<button
							className="ink-control"
							aria-label={isMuted ? 'Open microphone' : 'Close microphone'}
							aria-pressed={!isMuted}
							disabled={!sessionActive}
							onClick={onToggleMic}
							type="button"
						>
							{isMuted ? <IconMicrophoneOff size={20} stroke={1.75} /> : <IconMicrophone size={20} stroke={1.75} />}
						</button>
					</InkTooltip>
				) : null}
				{videoAvailable ? (
					<>
						<InkTooltip label={isVideoOn ? 'end video' : 'start video'}>
							<button
								className={['ink-control', isVideoOn ? 'ink-control--active' : ''].filter(Boolean).join(' ')}
								aria-label={isVideoOn ? 'End video' : 'Start video'}
								aria-pressed={isVideoOn}
								disabled={!sessionActive}
								onClick={onToggleVideo}
								type="button"
							>
								{isVideoOn ? <IconVideoOff size={20} stroke={1.75} /> : <IconVideo size={20} stroke={1.75} />}
							</button>
						</InkTooltip>
						{isVideoOn ? (
							<InkTooltip label="flip camera">
								<button
									className="ink-control"
									aria-label="Flip camera"
									disabled={!sessionActive}
									onClick={onFlipCamera}
									type="button"
								>
									<IconCameraRotate size={20} stroke={1.75} />
								</button>
							</InkTooltip>
						) : null}
					</>
				) : null}
				{textAvailable ? (
					<InkTooltip label={textComposerOpen ? 'hide text' : 'show text'}>
						<button
							className={['ink-control', textComposerOpen ? 'ink-control--active' : ''].filter(Boolean).join(' ')}
							aria-label={textComposerOpen ? 'Hide text composer' : 'Show text composer'}
							aria-pressed={textComposerOpen}
							disabled={!sessionActive}
							onClick={onToggleTextComposer}
							type="button"
						>
							<IconMessage size={20} stroke={1.75} />
						</button>
					</InkTooltip>
				) : null}
			</div>
			<div className="ink-controls__right">
				{canRestart ? (
					<InkTooltip label="start call">
						<button className="ink-control" aria-label="Start call" onClick={onRestart} type="button">
							<IconPhone size={20} stroke={1.75} />
						</button>
					</InkTooltip>
				) : (
					<InkTooltip label="end call">
						<button className="ink-control" aria-label="End call" onClick={onEnd} type="button">
							<IconPhoneOff size={20} stroke={1.75} />
						</button>
					</InkTooltip>
				)}
			</div>
		</div>
	);
}
