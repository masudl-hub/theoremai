/**
 * Video track length, frame size, and accompanying audio length from container
 * headers — MP4 / MOV / 3GP and Matroska / WebM. Frames are never decoded.
 *
 * @module
 */

import {
  type MatroskaTrack,
  MKV_AUDIO_TRACK,
  MKV_VIDEO_TRACK,
  matroska,
  opusSamplesFromNs,
} from './matroska.ts';
import { MP4_SOUND, MP4_VIDEO, mp4Tracks } from './mp4.ts';
import { OPUS_RATE } from './opus.ts';

const NS_PER_SECOND = 1e9;

/** What a video file holds, as its headers state it. */
export interface VideoInfo {
  /** Presented length of the first video track. */
  seconds: number;
  /** Coded frame size of the first video track. */
  width: number;
  height: number;
  /**
   * Decoded length of the first audio track (see `audioSeconds`) — `0` when
   * there is none, `undefined` when there is one whose length cannot be read
   * exactly.
   */
  audioSeconds: number | undefined;
}

function mp4Video(bytes: Uint8Array): VideoInfo | undefined {
  const tracks = mp4Tracks(bytes);
  const video = tracks?.find((t) => t.handler === MP4_VIDEO);
  if (!tracks || !video?.seconds || !video.width || !video.height) return undefined;
  const audio = tracks.find((t) => t.handler === MP4_SOUND);
  return {
    seconds: video.seconds,
    width: video.width,
    height: video.height,
    audioSeconds: audio ? audio.decodedSeconds : 0,
  };
}

/** End of the last frame: latest block timestamp plus one frame. */
function matroskaVideoSeconds(track: MatroskaTrack): number | undefined {
  if (track.lastNs === undefined) return undefined;
  const frameNs =
    track.defaultDurationNs ??
    (track.previousNs === undefined ? undefined : track.lastNs - track.previousNs);
  return frameNs === undefined ? undefined : (track.lastNs + frameNs) / NS_PER_SECOND;
}

function matroskaVideo(bytes: Uint8Array): VideoInfo | undefined {
  const file = matroska(bytes);
  const video = file?.tracks.find((t) => t.type === MKV_VIDEO_TRACK);
  if (!file || !video?.pixelWidth || !video.pixelHeight) return undefined;
  const seconds = (file.complete ? matroskaVideoSeconds(video) : undefined) ?? file.durationSeconds;
  if (!seconds || seconds <= 0) return undefined;
  const audio = file.tracks.find((t) => t.type === MKV_AUDIO_TRACK);
  const audioSeconds = !audio
    ? 0
    : file.complete && audio.opusSamples !== undefined
      ? Math.max(0, audio.opusSamples - opusSamplesFromNs(audio.codecDelayNs)) / OPUS_RATE
      : undefined;
  return { seconds, width: video.pixelWidth, height: video.pixelHeight, audioSeconds };
}

/**
 * Video track length, coded frame size, and first audio track length of an
 * MP4 / MOV / 3GP or Matroska / WebM file — identified by its bytes, not its
 * declared MIME type. `undefined` for anything else, or when the video track's
 * length or frame size cannot be read.
 *
 * MP4 video length is the track's edit-list-aware header duration; its audio
 * length is decoded samples (`Mp4Track.decodedSeconds`). Matroska video
 * ends one frame after its latest block (`DefaultDuration`, else the gap
 * between the two latest blocks), else at the segment's stated `Duration`;
 * Matroska audio is known only when it is unlaced Opus.
 */
export function videoInfo(bytes: Uint8Array): VideoInfo | undefined {
  return mp4Video(bytes) ?? matroskaVideo(bytes);
}
