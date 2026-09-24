import type { Profile } from '../kernel/types.ts';
import { resolveGuardrailPolicy } from './policy.ts';
import { TheoremError } from './theorem-error.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

interface Slot {
  day: string;
  count: number;
  busy: boolean;
}

/** Outcome of reserving a profile's per-client daily quota slot. */
type QuotaSlotStatus = 'ok' | 'busy' | 'quota' | 'not_configured';

const slots = new Map<string, Slot>();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function isLoopback(peer: string): boolean {
  return LOOPBACK.has(peer);
}

function cfConnectingIp(req: Request): string {
  return req.headers.get('cf-connecting-ip')?.trim() ?? '';
}

function slotKey(profileId: string, ip: string): string {
  return `${profileId}:${ip}`;
}

/** Returns whether a local request lacks the proxy header needed for quota identity. */
function skipQuota(peer: string, req: Request): boolean {
  return isLoopback(peer) && !cfConnectingIp(req);
}

/** Resolves the client identity, preferring Cloudflare's header for local peers. */
function clientIp(peer: string, req: Request): string {
  if (isLoopback(peer)) {
    const cf = cfConnectingIp(req);
    if (cf) {
      return cf;
    }
  }
  if (peer) {
    return peer;
  }
  return 'unknown';
}

/**
 * Reserves one profile-and-client daily quota slot. The reservation stays busy
 * until `releaseSlot` is called, preventing concurrent turns from overspending.
 */
function takeSlot(profile: Profile, ip: string, now: number): QuotaSlotStatus {
  const quota = resolveGuardrailPolicy(profile.guardrails).quota;
  if (!quota) {
    return 'not_configured';
  }
  const day = utcDay(now);
  const key = slotKey(profile.id, ip);
  let slot = slots.get(key);
  if (!slot || slot.day !== day) {
    slot = { day, count: 0, busy: false };
    slots.set(key, slot);
  }
  if (slot.busy) {
    return 'busy';
  }
  if (slot.count >= quota.perDay) {
    return 'quota';
  }
  slot.busy = true;
  slot.count += 1;
  return 'ok';
}

/** Releases an active quota reservation without decrementing its daily count. */
function releaseSlot(profile: Profile, ip: string): void {
  const slot = slots.get(slotKey(profile.id, ip));
  if (slot) {
    slot.busy = false;
  }
}

/**
 * The failure a tripped quota reports, or `undefined` when the profile has no
 * quota configured. Kind `rate_limit`; the user reads `quota.exhausted` from the
 * lexicon (`publicError(err, profile.lexicon)`).
 */
function quotaExhausted(profile: Profile): TheoremError | undefined {
  const quota = resolveGuardrailPolicy(profile.guardrails).quota;
  if (!quota) {
    return undefined;
  }
  return new TheoremError(
    'rate_limit',
    `${profile.id} used its daily quota of ${quota.perDay} turns`, // lexicon-exempt: internal diagnostic; the user reads the copy key
    { copy: { key: 'quota.exhausted', params: { perDay: quota.perDay } } },
  );
}

/** Clears all process-local quota counters; intended for tests or host resets. */
function resetSlots(): void {
  slots.clear();
}

export type { QuotaSlotStatus };
export { clientIp, quotaExhausted, releaseSlot, resetSlots, skipQuota, takeSlot };
