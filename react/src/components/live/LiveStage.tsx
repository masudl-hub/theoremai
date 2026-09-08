import {
	IconMessage,
	IconMicrophone,
	IconMicrophoneOff,
	IconPhone,
	IconPhoneOff,
	IconVideo,
	IconVideoOff,
} from '@tabler/icons-react';
import type { ProfileInputsInterface } from 'theorum/interface';
import type { CaptionFocus } from '../../client/live/caption-focus';
import type { LiveCaptionTurn } from '../../client/live/live-captions';
import type { LiveSessionStatus } from '../../client/live-client';
import '../../styles/live-stage.css';
import '../../styles/interface-runner.css';
import { InkWaveform } from '../InkWaveform';
import { InterfaceComposer } from '../InterfaceComposer';
import { LiveCaptionRail } from './LiveCaptionRail';

const liveTextInputs: ProfileInputsInterface = {
	text: true,
	attachments: null,
	voice: null,
};

export type LiveStageProps = {
	handle: string;
	stateLabel: string;
	status?: LiveSessionStatus;
	inputLevel?: number;
	outputLevel?: number;
	toolActive?: boolean;
	captionTurns?: LiveCaptionTurn[];
	interimUser?: string;
	interimAgent?: string;
	captionFocus?: CaptionFocus;
	isMuted?: boolean;
	isVideoOn?: boolean;
	voiceAvailable?: boolean;
	videoAvailable?: boolean;
	textAvailable?: boolean;
	textComposerOpen?: boolean;
	textDraft?: string;
	sessionActive?: boolean;
	canRestart?: boolean;
	error?: string;
	onCaptionFocusChange?: (focus: CaptionFocus) => void;
	onToggleMic?: () => void;
	onToggleVideo?: () => void;
	onToggleTextComposer?: () => void;
	onTextDraftChange?: (value: string) => void;
	onSendText?: () => void;
	onRestart?: () => void;
	onEnd?: () => void;
};

export function LiveStage({
	handle,
	stateLabel,
	status = 'disconnected',
	inputLevel = 0,
	outputLevel = 0,
	toolActive = false,
	captionTurns = [],
	interimUser = '',
	interimAgent = '',
	captionFocus = null,
	isMuted = false,
	isVideoOn = false,
	voiceAvailable = false,
	videoAvailable = false,
	textAvailable = false,
	textComposerOpen = false,
	textDraft = '',
	sessionActive = false,
	canRestart = false,
	error = '',
	onCaptionFocusChange,
	onToggleMic,
	onToggleVideo,
	onToggleTextComposer,
	onTextDraftChange,
	onSendText,
	onRestart,
	onEnd,
}: LiveStageProps) {
	const handleLabel = `@${handle}`;
	const canSendText = sessionActive && textDraft.trim().length > 0;

	return (
		<section className="live-stage">
			<div className="live-rail">
				<header className="live-head">
					<div className="live-head__main">
						<h1 className="live-head__handle">{handleLabel}</h1>
						<p className="live-head__state">{stateLabel}</p>
					</div>
					<LiveCaptionRail
						handle={handle}
						focus={captionFocus}
						interimAgent={interimAgent}
						interimUser={interimUser}
						onFocusChange={onCaptionFocusChange}
						turns={captionTurns}
					/>
				</header>

				<div className="live-wave-slot">
					<InkWaveform
						inputLevel={inputLevel}
						outputLevel={outputLevel}
						status={status}
						toolActive={toolActive}
						variant="hero"
					/>
				</div>

				<footer className="live-footer">
					{error ? (
						<p className="live-error" role="alert">
							{error}
						</p>
					) : null}

					{textComposerOpen && textAvailable ? (
						<div className="live-composer-slot">
							<InterfaceComposer
								busy={!sessionActive}
								canSubmit={canSendText}
								inputs={liveTextInputs}
								issues={[]}
								onSubmit={onSendText}
								onTextChange={onTextDraftChange}
								text={textDraft}
							/>
						</div>
					) : null}

					<hr className="ink-divider live-footer__divider" />

					<div className="ink-controls">
						<div className="ink-controls__left">
							{voiceAvailable ? (
								<button
									className="ink-control"
									aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
									aria-pressed={!isMuted}
									disabled={!sessionActive}
									onClick={onToggleMic}
									type="button"
								>
									{isMuted ? (
										<IconMicrophoneOff size={20} stroke={1.75} />
									) : (
										<IconMicrophone size={20} stroke={1.75} />
									)}
								</button>
							) : null}
							{videoAvailable ? (
								<button
									className={['ink-control', isVideoOn ? 'ink-control--active' : '']
										.filter(Boolean)
										.join(' ')}
									aria-label={isVideoOn ? 'Turn off video' : 'Turn on video'}
									aria-pressed={isVideoOn}
									disabled={!sessionActive}
									onClick={onToggleVideo}
									type="button"
								>
									{isVideoOn ? (
										<IconVideoOff size={20} stroke={1.75} />
									) : (
										<IconVideo size={20} stroke={1.75} />
									)}
								</button>
							) : null}
							{textAvailable ? (
								<button
									className={['ink-control', textComposerOpen ? 'ink-control--active' : '']
										.filter(Boolean)
										.join(' ')}
									aria-label={textComposerOpen ? 'Hide text composer' : 'Show text composer'}
									aria-pressed={textComposerOpen}
									disabled={!sessionActive}
									onClick={onToggleTextComposer}
									type="button"
								>
									<IconMessage size={20} stroke={1.75} />
								</button>
							) : null}
						</div>
						<div className="ink-controls__right">
							{canRestart ? (
								<button
									className="ink-control"
									aria-label="Restart live session"
									onClick={onRestart}
									type="button"
								>
									<IconPhone size={20} stroke={1.75} />
								</button>
							) : (
								<button
									className="ink-control"
									aria-label="End live session"
									onClick={onEnd}
									type="button"
								>
									<IconPhoneOff size={20} stroke={1.75} />
								</button>
							)}
						</div>
					</div>
				</footer>
			</div>
		</section>
	);
}
