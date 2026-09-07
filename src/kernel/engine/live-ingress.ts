/**
 * Live realtime ingress — profile gates for sendAudio / sendVideo / sendText.
 *
 * @module
 */

import { TheorumError } from '../../guardrails/error.ts';
import type { LiveIngressSpec, LiveProfile, Profile } from '../types.ts';

export type LiveIngressChannel = keyof LiveIngressSpec;

const LIVE_INGRESS_CHANNELS: LiveIngressChannel[] = ['audio', 'video', 'text'];

function assertLiveProfile(profile: Profile): LiveProfile {
  if (profile.type !== 'live') {
    throw new TheorumError(`Profile '${profile.id}' is not type 'live'`);
  }
  return profile;
}

/** Default when `live.ingress.<channel>` is omitted — camera is opt-in. */
export function liveIngressChannelDefault(channel: LiveIngressChannel): boolean {
  return channel !== 'video';
}

/** Resolve one channel from an ingress spec object (no profile wrapper). */
export function liveIngressEnabledFromSpec(
  ingress: LiveIngressSpec | undefined,
  channel: LiveIngressChannel,
): boolean {
  const value = ingress?.[channel];
  if (value === undefined) return liveIngressChannelDefault(channel);
  return value;
}

/** Whether a realtime ingress channel is enabled on the profile. */
export function liveIngressEnabled(profile: Profile, channel: LiveIngressChannel): boolean {
  const live = assertLiveProfile(profile);
  return liveIngressEnabledFromSpec(live.live.ingress, channel);
}

/** True when at least one realtime ingress channel is enabled. */
export function hasAnyLiveIngress(profile: Profile): boolean {
  const live = assertLiveProfile(profile);
  return LIVE_INGRESS_CHANNELS.some((channel) =>
    liveIngressEnabledFromSpec(live.live.ingress, channel),
  );
}

/** Reject profiles with every ingress channel disabled. */
export function assertLiveIngressConfigured(profile: Profile): void {
  const live = assertLiveProfile(profile);
  if (hasAnyLiveIngress(live)) return;
  throw new TheorumError(
    `Profile '${live.id}': at least one live.ingress channel (audio, video, text) must be enabled`,
  );
}

/** Reject send* calls when the profile disabled that ingress channel. */
export function assertLiveIngress(profile: Profile, channel: LiveIngressChannel): void {
  if (liveIngressEnabled(profile, channel)) return;
  throw new TheorumError(
    `Profile '${profile.id}' live.ingress.${channel} is disabled — cannot send on this channel`,
  );
}
