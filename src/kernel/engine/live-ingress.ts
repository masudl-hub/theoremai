import { TheoremError } from '../../guardrails/error.ts';
import type { LiveIngressSpec, LiveProfile, Profile } from '../types.ts';

export type LiveIngressChannel = keyof LiveIngressSpec;

const LIVE_INGRESS_CHANNELS: LiveIngressChannel[] = ['audio', 'video', 'text'];

function assertLiveProfile(profile: Profile): LiveProfile {
  if (profile.type !== 'live') {
    throw new TheoremError('request', `Profile '${profile.id}' is not type 'live'`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return profile;
}

/** Default when `live.ingress.<channel>` is omitted — mic and camera on, typed text off. */
export function liveIngressChannelDefault(channel: LiveIngressChannel): boolean {
  return channel !== 'text';
}

export function liveIngressEnabledFromSpec(
  ingress: LiveIngressSpec | undefined,
  channel: LiveIngressChannel,
): boolean {
  const value = ingress?.[channel];
  if (value === undefined) return liveIngressChannelDefault(channel);
  return value;
}

export function liveIngressEnabled(profile: Profile, channel: LiveIngressChannel): boolean {
  const live = assertLiveProfile(profile);
  return liveIngressEnabledFromSpec(live.live.ingress, channel);
}

export function hasAnyLiveIngress(profile: Profile): boolean {
  const live = assertLiveProfile(profile);
  return LIVE_INGRESS_CHANNELS.some((channel) =>
    liveIngressEnabledFromSpec(live.live.ingress, channel),
  );
}

export function assertLiveIngressConfigured(profile: Profile): void {
  const live = assertLiveProfile(profile);
  if (hasAnyLiveIngress(live)) return;
  throw new TheoremError(
    'config',
    `Profile '${live.id}': at least one live.ingress channel (audio, video, text) must be enabled`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

export function assertLiveIngress(profile: Profile, channel: LiveIngressChannel): void {
  if (liveIngressEnabled(profile, channel)) return;
  throw new TheoremError(
    'request',
    `Profile '${profile.id}' live.ingress.${channel} is disabled — cannot send on this channel`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}
