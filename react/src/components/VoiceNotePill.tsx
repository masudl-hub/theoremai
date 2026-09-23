import { voiceLabelFromMime } from '../client/voice-label';
import { InkWaveform } from './InkWaveform';
import { useVoicePlayback } from './use-voice-playback';

export type VoiceNotePillProps = {
	src: string;
	mimeType?: string;
	label?: string;
};

export function VoiceNotePill({ src, mimeType = 'audio/webm', label }: VoiceNotePillProps) {
	const { playing, outputLevel, toggle, audioProps } = useVoicePlayback();
	const ariaLabel = label ?? voiceLabelFromMime(mimeType);

	return (
		<div className="iface-voice-player">
			<button
				className="iface-attach-pill iface-attach-pill--voice iface-voice-player__hit"
				aria-label={playing ? `Pause ${ariaLabel}` : `Play ${ariaLabel}`}
				aria-pressed={playing}
				onClick={() => {
					void toggle();
				}}
				type="button"
			>
				<div className="iface-attach-pill__wave" aria-hidden="true">
					<InkWaveform
						frozen={!playing}
						inputLevel={0}
						outputLevel={outputLevel}
						status={playing ? 'speaking' : 'ready'}
						variant="pill"
					/>
				</div>
			</button>
			<audio {...audioProps} className="iface-voice-player__audio" src={src} />
		</div>
	);
}
