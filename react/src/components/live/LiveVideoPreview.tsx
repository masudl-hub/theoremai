import { useEffect, useRef } from 'react';
import type { LiveFacingMode } from '../../client/live/live-video';

export type LiveVideoPreviewProps = {
	video: HTMLVideoElement | null;
	facingMode?: LiveFacingMode;
};

/** Mounts the capture video element into the rail — straight edges, no chrome. */
export function LiveVideoPreview({ video, facingMode = 'user' }: LiveVideoPreviewProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !video) return;
		host.replaceChildren(video);
		return () => {
			if (video.parentElement === host) {
				host.removeChild(video);
			}
		};
	}, [video]);

	if (!video) return null;

	return (
		<div
			ref={hostRef}
			className={[
				'live-video-preview',
				facingMode === 'user' ? 'live-video-preview--mirror' : '',
			]
				.filter(Boolean)
				.join(' ')}
		/>
	);
}
