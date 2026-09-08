import { pickMediaRecorderMime } from 'theorum/interface';
import { timeDomainBytesToLevel } from './audio-level';

export type VoiceRecorderFailureCode = 'unsupported' | 'permission' | 'empty' | 'device';

export class VoiceRecorderFailure extends Error {
	readonly code: VoiceRecorderFailureCode;

	constructor(code: VoiceRecorderFailureCode, message: string) {
		super(message);
		this.name = 'VoiceRecorderFailure';
		this.code = code;
	}
}

function extensionForMime(mime: string): string {
	if (mime.includes('webm')) return 'webm';
	if (mime.includes('mp4')) return 'm4a';
	if (mime.includes('wav')) return 'wav';
	if (mime.includes('mpeg')) return 'mp3';
	return 'bin';
}

function isPermissionDenied(err: unknown): boolean {
	return err instanceof DOMException && err.name === 'NotAllowedError';
}

/** Headless MediaRecorder session for turn-composer voice notes. */
export class ComposerVoiceRecorder {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private rafId = 0;
	private mime = '';
	private recording = false;

	constructor(
		private readonly accept: string[],
		private readonly onLevel?: (level: number) => void,
	) {}

	async start(): Promise<void> {
		this.disposeTracks();

		const mime = pickMediaRecorderMime(this.accept);
		if (!mime) {
			throw new VoiceRecorderFailure(
				'unsupported',
				'This browser cannot record an accepted voice format.',
			);
		}

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
		} catch (err) {
			if (isPermissionDenied(err)) {
				throw new VoiceRecorderFailure('permission', 'Microphone permission was denied.');
			}
			const message = err instanceof Error ? err.message : String(err);
			throw new VoiceRecorderFailure('device', message);
		}

		this.mime = mime;
		this.chunks = [];
		this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
		this.recorder.ondataavailable = (event) => {
			if (event.data.size > 0) this.chunks.push(event.data);
		};
		this.recorder.start(250);
		this.recording = true;
		this.startMeter();
	}

	async stop(): Promise<File> {
		if (!this.recorder || !this.recording) {
			throw new VoiceRecorderFailure('empty', 'No voice recording in progress.');
		}

		const recorder = this.recorder;
		const blob = await new Promise<Blob>((resolve, reject) => {
			recorder.onerror = () => {
				reject(new VoiceRecorderFailure('device', 'Recording failed'));
			};
			recorder.onstop = () => {
				const parts = this.chunks;
				if (parts.length === 0) {
					reject(new VoiceRecorderFailure('empty', 'Recording was empty'));
					return;
				}
				resolve(new Blob(parts, { type: this.mime }));
			};
			recorder.stop();
		});

		this.recording = false;
		this.stopMeter();
		this.disposeTracks();

		if (blob.size === 0) {
			throw new VoiceRecorderFailure('empty', 'Recording was empty.');
		}

		const ext = extensionForMime(this.mime);
		return new File([blob], `voice-note.${ext}`, { type: this.mime });
	}

	cancel(): void {
		this.recording = false;
		this.stopMeter();
		if (this.recorder && this.recorder.state !== 'inactive') {
			try {
				this.recorder.stop();
			} catch {
				// ignore
			}
		}
		this.disposeTracks();
		this.chunks = [];
		this.recorder = null;
	}

	dispose(): void {
		this.cancel();
	}

	private startMeter(): void {
		if (!this.stream) return;

		const AudioContextClass = window.AudioContext;
		this.audioContext = new AudioContextClass();
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 2048;
		this.source = this.audioContext.createMediaStreamSource(this.stream);
		this.source.connect(this.analyser);

		const tick = () => {
			if (!this.analyser || !this.recording) return;
			const data = new Uint8Array(this.analyser.fftSize);
			this.analyser.getByteTimeDomainData(data);
			this.onLevel?.(timeDomainBytesToLevel(data));
			this.rafId = requestAnimationFrame(tick);
		};
		this.rafId = requestAnimationFrame(tick);
	}

	private stopMeter(): void {
		cancelAnimationFrame(this.rafId);
		this.rafId = 0;
		this.onLevel?.(0);
		this.source?.disconnect();
		this.analyser?.disconnect();
		this.source = null;
		this.analyser = null;
		if (this.audioContext && this.audioContext.state !== 'closed') {
			void this.audioContext.close();
		}
		this.audioContext = null;
	}

	private disposeTracks(): void {
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		this.stream = null;
	}
}

export function isVoiceRecorderFailure(value: unknown): value is VoiceRecorderFailure {
	return value instanceof VoiceRecorderFailure;
}
