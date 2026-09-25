import { TheoremError } from '../../../../mod.ts';

const JPEG_QUALITY = 0.62;
const FRAME_INTERVAL_MS = 400;

export type LiveFacingMode = 'user' | 'environment';

export type LiveVideoCapture = {
	stop: () => void;
	readonly video: HTMLVideoElement;
	facingMode: () => LiveFacingMode;
	flip: () => Promise<LiveFacingMode>;
};

type CaptureState = {
	stream: MediaStream;
	facing: LiveFacingMode;
};

function openCamera(facing: LiveFacingMode): Promise<MediaStream> {
	return navigator.mediaDevices.getUserMedia({
		video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
		audio: false,
	});
}

export function startLiveVideoCapture(
	onFrame: (base64: string) => void,
	options?: { facingMode?: LiveFacingMode },
): Promise<LiveVideoCapture> {
	const initialFacing: LiveFacingMode = options?.facingMode ?? 'user';

	return openCamera(initialFacing).then((stream) => {
		const video = document.createElement('video');
		video.srcObject = stream;
		video.muted = true;
		video.playsInline = true;
		video.setAttribute('playsinline', '');

		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d');
		if (!context) {
			for (const track of stream.getTracks()) track.stop();
			throw new TheoremError('unsupported', 'no 2d canvas for live video'); // lexicon-exempt: internal diagnostic
		}

		let timer: ReturnType<typeof setInterval> | null = null;
		let stopped = false;
		let state: CaptureState = { stream, facing: initialFacing };

		const capture = () => {
			if (stopped || video.videoWidth === 0) return;
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			context.drawImage(video, 0, 0);
			const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
			const base64 = dataUrl.split(',')[1];
			if (base64) onFrame(base64);
		};

		const startTimer = () => {
			if (timer || stopped) return;
			timer = setInterval(capture, FRAME_INTERVAL_MS);
		};

		void video.play().then(startTimer);

		return {
			video,
			facingMode: () => state.facing,
			flip: async () => {
				if (stopped) return state.facing;
				const nextFacing: LiveFacingMode =
					state.facing === 'user' ? 'environment' : 'user';
				const nextStream = await openCamera(nextFacing);
				for (const track of state.stream.getTracks()) track.stop();
				state = { stream: nextStream, facing: nextFacing };
				video.srcObject = nextStream;
				await video.play();
				return nextFacing;
			},
			stop: () => {
				stopped = true;
				if (timer) clearInterval(timer);
				timer = null;
				video.srcObject = null;
				for (const track of state.stream.getTracks()) track.stop();
			},
		};
	});
}
