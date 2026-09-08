const JPEG_QUALITY = 0.62;
const FRAME_INTERVAL_MS = 400;

export type LiveVideoCapture = {
	stop: () => void;
};

export function startLiveVideoCapture(
	onFrame: (base64: string) => void,
): Promise<LiveVideoCapture> {
	return navigator.mediaDevices
		.getUserMedia({
			video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
			audio: false,
		})
		.then((stream) => {
			const video = document.createElement('video');
			video.srcObject = stream;
			video.muted = true;
			video.playsInline = true;

			const canvas = document.createElement('canvas');
			const context = canvas.getContext('2d');
			if (!context) {
				for (const track of stream.getTracks()) track.stop();
				throw new Error('Canvas unavailable for live video');
			}

			let timer: ReturnType<typeof setInterval> | null = null;
			let stopped = false;

			const capture = () => {
				if (stopped || video.videoWidth === 0) return;
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				context.drawImage(video, 0, 0);
				const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
				const base64 = dataUrl.split(',')[1];
				if (base64) onFrame(base64);
			};

			void video.play().then(() => {
				timer = setInterval(capture, FRAME_INTERVAL_MS);
			});

			return {
				stop: () => {
					stopped = true;
					if (timer) clearInterval(timer);
					video.srcObject = null;
					for (const track of stream.getTracks()) track.stop();
				},
			};
		});
}
