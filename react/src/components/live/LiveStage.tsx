import type { ProfileInputsInterface } from '../../../../src/interface/mod.ts';
import type { CaptionFocus } from '../../client/live/caption-focus';
import type { LiveCaptionTurn } from '../../client/live/live-captions';
import type { LiveFacingMode } from '../../client/live/live-video';
import type { LiveSessionStatus } from '../../client/live-client';
import '../../styles/live-stage.css';
import '../../styles/interface-runner.css';
import { InkWaveform } from '../InkWaveform';
import { InterfaceComposer } from '../InterfaceComposer';
import { LiveCaptionRail } from './LiveCaptionRail';
import { LiveVideoPreview } from './LiveVideoPreview';
import { LiveStageControls } from './LiveStageControls';

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

function LiveStageHead({
	handle,
	stateLabel,
	captionTurns,
	interimUser,
	interimAgent,
	captionFocus,
	onCaptionFocusChange,
	isVideoOn,
	videoPreview,
	videoFacingMode,
}: {
	handle: string;
	stateLabel: string;
	captionTurns: LiveCaptionTurn[];
	interimUser: string;
	interimAgent: string;
	captionFocus: CaptionFocus;
	onCaptionFocusChange?: (focus: CaptionFocus) => void;
	isVideoOn: boolean;
	videoPreview: HTMLVideoElement | null;
	videoFacingMode: 'user' | 'environment';
}) {
	const handleLabel = `@${handle}`;
	const showVideoPreview = isVideoOn && videoPreview !== null;
	return (
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
	);
}

function LiveComposerSlot({
	textComposerOpen,
	textAvailable,
	sessionActive,
	textDraft,
	onTextDraftChange,
	onSendText,
}: {
	textComposerOpen: boolean;
	textAvailable: boolean;
	sessionActive: boolean;
	textDraft: string;
	onTextDraftChange?: (value: string) => void;
	onSendText?: () => void;
}) {
	if (!textComposerOpen || !textAvailable) return null;
	const canSendText = sessionActive && textDraft.trim().length > 0;
	return (
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
	);
}

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
	return (
		<section className="live-stage">
			<div className="live-rail">
				<LiveStageHead
					handle={handle}
					stateLabel={stateLabel}
					captionTurns={captionTurns}
					interimUser={interimUser}
					interimAgent={interimAgent}
					captionFocus={captionFocus}
					onCaptionFocusChange={onCaptionFocusChange}
					isVideoOn={isVideoOn}
					videoPreview={videoPreview}
					videoFacingMode={videoFacingMode}
				/>

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

					<LiveComposerSlot
						textComposerOpen={textComposerOpen}
						textAvailable={textAvailable}
						sessionActive={sessionActive}
						textDraft={textDraft}
						onTextDraftChange={onTextDraftChange}
						onSendText={onSendText}
					/>

					<hr className="ink-divider live-footer__divider" />

					<LiveStageControls
						canRestart={canRestart}
						isMuted={isMuted}
						isVideoOn={isVideoOn}
						onEnd={onEnd}
						onFlipCamera={onFlipCamera}
						onRestart={onRestart}
						onToggleMic={onToggleMic}
						onToggleTextComposer={onToggleTextComposer}
						onToggleVideo={onToggleVideo}
						sessionActive={sessionActive}
						textAvailable={textAvailable}
						textComposerOpen={textComposerOpen}
						videoAvailable={videoAvailable}
						voiceAvailable={voiceAvailable}
					/>
				</footer>
			</div>
		</section>
	);
}
