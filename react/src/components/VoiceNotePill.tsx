import { useEffect, useRef, useState } from 'react';
import { voiceLabelFromMime } from '../client/voice-label';
import { InkWaveform } from './InkWaveform';

export type VoiceNotePillProps = {
	src: string;
	mimeType?: string;
	label?: string;
};

export function VoiceNotePill({ src, mimeType = 'audio/webm', label }: VoiceNotePillProps) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [playing, setPlaying] = useState(false);
	const playingRef = useRef(false);
	const [outputLevel, setOutputLevel] = useState(0);
	const rafIdRef = useRef(0);

	const ariaLabel = label ?? voiceLabelFromMime(mimeType);

	function stopMeter() {
		cancelAnimationFrame(rafIdRef.current);
		rafIdRef.current = 0;
		setOutputLevel(0);
	}

	function startMeter() {
		stopMeter();
		const tick = (time: number) => {
			if (!playingRef.current) return;
			setOutputLevel(0.28 + 0.22 * (0.5 + 0.5 * Math.sin(time * 0.008)));
			rafIdRef.current = requestAnimationFrame(tick);
		};
		rafIdRef.current = requestAnimationFrame(tick);
	}

	useEffect(() => {
		return () => {
			cancelAnimationFrame(rafIdRef.current);
		};
	}, []);

	async function toggle() {
		const audio = audioRef.current;
		if (!audio) return;
		if (audio.paused) {
			try {
				await audio.play();
			} catch {
				playingRef.current = false;
				setPlaying(false);
				stopMeter();
			}
			return;
		}
		audio.pause();
	}

	function onPlay() {
		playingRef.current = true;
		setPlaying(true);
		startMeter();
	}

	function onPause() {
		playingRef.current = false;
		setPlaying(false);
		stopMeter();
	}

	function onEnded() {
		playingRef.current = false;
		setPlaying(false);
		stopMeter();
		if (audioRef.current) audioRef.current.currentTime = 0;
	}

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
			<audio
				ref={audioRef}
				className="iface-voice-player__audio"
				preload="metadata"
				src={src}
				onEnded={onEnded}
				onPause={onPause}
				onPlay={onPlay}
			/>
		</div>
	);
}
