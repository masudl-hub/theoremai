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
import type { ProfileInputsInterface } from 'theorum/interface';
import type { CaptionFocus } from '../../client/live/caption-focus';
import type { LiveCaptionTurn } from '../../client/live/live-captions';
import type { LiveFacingMode } from '../../client/live/live-video';
import type { LiveSessionStatus } from '../../client/live-client';
import '../../styles/live-stage.css';
import '../../styles/interface-runner.css';
import { InkTooltip } from '../InkTooltip';
import { InkWaveform } from '../InkWaveform';
import { InterfaceComposer } from '../InterfaceComposer';
import { LiveCaptionRail } from './LiveCaptionRail';
import { LiveVideoPreview } from './LiveVideoPreview';

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
	videoPreview?: HTMLVideoElement | null;
	videoFacingMode?: LiveFacingMode;
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
	onFlipCamera?: () => void;
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
	videoPreview = null,
	videoFacingMode = 'user',
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
	onFlipCamera,
	onToggleTextComposer,
	onTextDraftChange,
	onSendText,
	onRestart,
	onEnd,
}: LiveStageProps) {
	const handleLabel = `@${handle}`;
	const canSendText = sessionActive && textDraft.trim().length > 0;
	const showVideoPreview = isVideoOn && videoPreview !== null;

	return (
		<section className="live-stage">
			<div className="live-rail">
				<header className="live-head">
					<div className="live-head__main">
						<h1 className="live-head__handle">{handleLabel}</h1>
						<p className="live-head__state">{stateLabel}</p>
					</div>
					<div className="live-head__side">
						<LiveCaptionRail
							handle={handle}
							focus={captionFocus}
							interimAgent={interimAgent}
							interimUser={interimUser}
							onFocusChange={onCaptionFocusChange}
							turns={captionTurns}
						/>
						{showVideoPreview ? (
							<LiveVideoPreview facingMode={videoFacingMode} video={videoPreview} />
						) : null}
					</div>
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
								inputLocked={!sessionActive || !canSendText}
								inputs={liveTextInputs}
								issues={[]}
								onSubmit={onSendText}
								onTextChange={onTextDraftChange}
								phase="idle"
								text={textDraft}
							/>
						</div>
					) : null}

					<hr className="ink-divider live-footer__divider" />

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
										{isMuted ? (
											<IconMicrophoneOff size={20} stroke={1.75} />
										) : (
											<IconMicrophone size={20} stroke={1.75} />
										)}
									</button>
								</InkTooltip>
							) : null}
							{videoAvailable ? (
								<>
									<InkTooltip label={isVideoOn ? 'end video' : 'start video'}>
										<button
											className={['ink-control', isVideoOn ? 'ink-control--active' : '']
												.filter(Boolean)
												.join(' ')}
											aria-label={isVideoOn ? 'End video' : 'Start video'}
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
								</InkTooltip>
							) : null}
						</div>
						<div className="ink-controls__right">
							{canRestart ? (
								<InkTooltip label="start call">
									<button
										className="ink-control"
										aria-label="Start call"
										onClick={onRestart}
										type="button"
									>
										<IconPhone size={20} stroke={1.75} />
									</button>
								</InkTooltip>
							) : (
								<InkTooltip label="end call">
									<button
										className="ink-control"
										aria-label="End call"
										onClick={onEnd}
										type="button"
									>
										<IconPhoneOff size={20} stroke={1.75} />
									</button>
								</InkTooltip>
							)}
						</div>
					</div>
				</footer>
			</div>
		</section>
	);
}
