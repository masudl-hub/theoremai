import type { LiveProfileInterface } from '../../../../src/interface/mod.ts';
import { LiveStage } from './LiveStage';
import { LiveToolGatePanel } from './LiveToolGatePanel';
import { useLiveRunnerModel } from './use-live-runner-model';

export type LiveRunnerProps = {
	iface: LiveProfileInterface;
	/** Resolve the live profile id to open on the relay. */
	registerProfile: () => Promise<string>;
};

function LiveRunnerView(props: ReturnType<typeof useLiveRunnerModel>) {
	return (
		<div className="live-runner">
			<LiveStage
				captionFocus={props.captionFocus}
				captionTurns={props.captions.turns}
				error={props.error}
				handle={props.handle}
				inputLevel={props.inputLevel}
				interimAgent={props.captions.interimAgent}
				interimUser={props.captions.interimUser}
				isMuted={props.isMuted}
				isVideoOn={props.isVideoOn}
				onCaptionFocusChange={props.setCaptionFocus}
				onEnd={props.handleEnd}
				onRestart={() => {
					void props.handleRestart();
				}}
				onSendText={props.handleSendText}
				onTextDraftChange={props.setTextDraft}
				onToggleMic={props.handleToggleMic}
				onFlipCamera={() => {
					void props.handleFlipCamera();
				}}
				onToggleTextComposer={props.handleToggleTextComposer}
				onToggleVideo={() => {
					void props.handleToggleVideo();
				}}
				outputLevel={props.outputLevel}
				sessionActive={props.sessionActive}
				stateLabel={props.stateLabel}
				status={props.status}
				textAvailable={props.textAvailable}
				textComposerOpen={props.textComposerOpen}
				textDraft={props.textDraft}
				toolActive={props.toolActive}
				videoAvailable={props.videoAvailable}
				videoFacingMode={props.videoFacingMode}
				videoPreview={props.videoPreview}
				voiceAvailable={props.voiceAvailable}
				canRestart={props.canRestart}
			/>

			{props.gatePrompt ? (
				<LiveToolGatePanel
					gate={props.gatePrompt.gate}
					input={props.gatePrompt.input}
					onResolve={props.resolveGateDecision}
				/>
			) : null}
		</div>
	);
}

export function LiveRunner({ iface, registerProfile }: LiveRunnerProps) {
	const model = useLiveRunnerModel(iface, registerProfile);
	return <LiveRunnerView {...model} />;
}
