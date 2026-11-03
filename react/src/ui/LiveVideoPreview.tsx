import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { useEffect, useRef } from 'react';
import type { LiveFacingMode } from '../client/live/live-video.ts';
import { useLabels } from './labels-provider.tsx';

/**
 * The camera preview: atop the call's captions, or in its tile. The capture element comes
 * from the session client, so it is mounted imperatively; it sits one level
 * below AspectRatio, so it carries its own fill and mirror styles.
 */
export function LiveVideoPreview({
  video,
  facingMode,
}: {
  video: HTMLVideoElement;
  facingMode: LiveFacingMode;
}) {
  const t = useLabels();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    Object.assign(video.style, {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      display: 'block',
    });
    host.replaceChildren(video);
    return () => {
      if (video.parentElement === host) host.removeChild(video);
    };
  }, [video]);

  useEffect(() => {
    video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : '';
  }, [video, facingMode]);

  return (
    <AspectRatio ratio={4 / 3} fit="cover">
      <div ref={hostRef} aria-label={t('@theorem.live.camera_preview')} role="img" />
    </AspectRatio>
  );
}
