import { useEffect, useRef, useState } from 'react';
import type { InkWaveLevels } from './InkWaveform.tsx';

/**
 * Click-to-play state for a voice note: an `<audio>` ref, whether it plays,
 * and a gentle output level that drives the ink waveform while it does.
 */
export function useVoicePlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const levelsRef = useRef<InkWaveLevels>({ input: 0, output: 0 });
  const rafIdRef = useRef(0);

  function stopMeter() {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = 0;
    levelsRef.current.output = 0;
  }

  function startMeter() {
    stopMeter();
    const tick = (time: number) => {
      if (!playingRef.current) return;
      levelsRef.current.output = 0.28 + 0.22 * (0.5 + 0.5 * Math.sin(time * 0.008));
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  function settle(isPlaying: boolean) {
    playingRef.current = isPlaying;
    setPlaying(isPlaying);
    if (isPlaying) startMeter();
    else stopMeter();
  }

  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      settle(false);
    }
  }

  /** Spread onto the `<audio>` element. */
  const audioProps = {
    ref: audioRef,
    preload: 'metadata' as const,
    onPlay: () => settle(true),
    onPause: () => settle(false),
    onEnded: () => {
      settle(false);
      if (audioRef.current) audioRef.current.currentTime = 0;
    },
  };

  return { playing, levelsRef, toggle, audioProps };
}
