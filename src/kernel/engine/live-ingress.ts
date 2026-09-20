/**
 * Live realtime ingress — profile gates for sendAudio / sendVideo / sendText.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { LiveIngressSpec, LiveProfile, Profile } from '../types.ts';

export type LiveIngressChannel = keyof LiveIngressSpec;

const LIVE_INGRESS_CHANNELS: LiveIngressChannel[] = ['audio', 'video', 'text'];

function assertLiveProfile(profile: Profile): LiveProfile {
  if (profile.type !== 'live') {
    throw new TheoremError(`Profile '${profile.id}' is not type 'live'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return profile;
}

/** Default when `live.ingress.<channel>` is omitted — mic and camera on, typed text off. */
export function liveIngressChannelDefault(channel: LiveIngressChannel): boolean {
  return channel !== 'text';
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
  throw new TheoremError(
    `Profile '${live.id}': at least one live.ingress channel (audio, video, text) must be enabled`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

/** Reject send* calls when the profile disabled that ingress channel. */
export function assertLiveIngress(profile: Profile, channel: LiveIngressChannel): void {
  if (liveIngressEnabled(profile, channel)) return;
  throw new TheoremError(
    `Profile '${profile.id}' live.ingress.${channel} is disabled — cannot send on this channel`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}
