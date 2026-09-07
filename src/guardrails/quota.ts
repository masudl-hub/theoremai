import type { Profile } from '../kernel/types.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

interface Slot {
  day: string;
  count: number;
  busy: boolean;
}

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

function skipQuota(peer: string, req: Request): boolean {
  return isLoopback(peer) && !cfConnectingIp(req);
}

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

function takeSlot(profile: Profile, ip: string, now: number): QuotaSlotStatus {
  const quota = profile.guardrails?.quota;
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

function releaseSlot(profile: Profile, ip: string): void {
  const slot = slots.get(slotKey(profile.id, ip));
  if (slot) {
    slot.busy = false;
  }
}

function quotaMessage(profile: Profile): string {
  return `Enjoying ${profile.identity.handle}? You've reached today's limit`;
}

function resetSlots(): void {
  slots.clear();
}

export type { QuotaSlotStatus };
export { clientIp, quotaMessage, releaseSlot, resetSlots, skipQuota, takeSlot };
