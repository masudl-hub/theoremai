import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { splitTurnAttachments } from '../../src/kernel/registry/attachments.ts';
import type { Profile, TurnBlob, TurnMediaRef } from '../../src/kernel/types.ts';

const SEEDS = Number(Deno.env.get('FUZZ_SEEDS') ?? 4000);
const TYPES = [
  'image/png',
  'IMAGE/PNG; q=1',
  'image/svg+xml',
  'image/gif',
  'audio/wav',
  'audio/x-m4a',
  'video/mp4',
  'application/pdf',
  'application/x-foo',
  'text/plain; charset=utf-8',
  'not a type',
  'image/',
  '',
];
const ACCEPTS = [
  undefined,
  [],
  ['image/png'],
  ['image/*'],
  ['audio/*', 'video/mp4'],
  ['application/pdf', 'text/plain', 'image/svg+xml'],
  ['application/*'],
];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, actual }, { label, actual: expected });
}

const essence = (mime: string) => (mime.split(';')[0] ?? '').trim().toLowerCase();
const isMime = (mime: string) =>
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(essence(mime));
const takes = (accept: readonly string[], mime: string) =>
  isMime(mime) &&
  accept.some((rule) =>
    rule.endsWith('/*') ? essence(mime).startsWith(rule.slice(0, -1)) : rule === essence(mime),
  );

type Item = TurnBlob | TurnMediaRef;

/** The checks a file fails on its own, in the order the kernel reports them. */
function ownIssues(
  item: Item,
  accept: readonly string[] | undefined,
  limits: { maxBytes: number; maxTurnBytes: number },
  channel: 'attachment' | 'voice',
): string[] {
  if (!accept) return [channel === 'voice' ? 'voice_not_accepted' : 'attachments_not_accepted'];
  const issues: string[] = [];
  if (!takes(accept, item.mimeType)) issues.push('mime_not_allowed');
  if ('data' in item) {
    const size = atob(item.data).length;
    if (size > limits.maxBytes) issues.push('file_too_large');
    if (size > limits.maxTurnBytes) issues.push('turn_too_large');
  }
  return issues;
}

Deno.test('fuzz: each file the profile does not take is left out, alone, and only what names no file refuses', () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const limits = {
      maxFiles: 1 + Math.floor(next() * 4),
      maxBytes: 2 + Math.floor(next() * 6),
      maxTurnBytes: 4 + Math.floor(next() * 14),
    };
    const accept = { attachment: pick(ACCEPTS), voice: pick(ACCEPTS) };
    const profile = {
      id: 'p',
      type: 'text',
      inputs: {
        text: true,
        ...(accept.attachment ? { attachments: { accept: accept.attachment } } : {}),
        ...(accept.voice ? { voice: { accept: accept.voice } } : {}),
        ...limits,
      },
    } as unknown as Profile;
    const item = (): Item =>
      next() < 0.2
        ? { mimeType: pick(TYPES), uri: `files/${String(seed)}` }
        : { mimeType: pick(TYPES), data: btoa('x'.repeat(Math.floor(next() * 10))) };
    const attachments =
      next() < 0.15 ? undefined : Array.from({ length: Math.floor(next() * 5) }, item);
    const voice =
      next() < 0.5
        ? undefined
        : Array.from({ length: Math.floor(next() * 3) }, item).filter(
            (one): one is TurnBlob => 'data' in one,
          );

    const expectLeft: Array<{ mimeType: string; channel: string; codes: string[] }> = [];
    const keep = <T extends Item>(items: T[] | undefined, channel: 'attachment' | 'voice') =>
      items?.filter((one) => {
        const codes = ownIssues(one, accept[channel], limits, channel);
        if (codes.length > 0) expectLeft.push({ mimeType: one.mimeType, channel, codes });
        return codes.length === 0;
      });
    const kept = { attachments: keep(attachments, 'attachment'), voice: keep(voice, 'voice') };
    const keptAll = [...(kept.attachments ?? []), ...(kept.voice ?? [])];
    const bytes = keptAll.reduce(
      (sum, one) => sum + ('data' in one ? atob(one.data).length : 0),
      0,
    );
    const turnCodes = [
      ...(keptAll.length > limits.maxFiles ? ['too_many_files'] : []),
      ...(bytes > limits.maxTurnBytes ? ['turn_too_large'] : []),
    ];

    let result: ReturnType<typeof splitTurnAttachments> | undefined;
    let refused: string | undefined;
    try {
      result = splitTurnAttachments(profile, attachments, voice);
    } catch (err) {
      if (!(err instanceof TheoremError)) throw err;
      refused = err.message;
    }
    const label = `seed ${String(seed)}`;
    if (turnCodes.length > 0) {
      check(refused, `attachments refused: ${turnCodes.join(', ')}`, `${label} refused`);
      continue;
    }
    check(refused, undefined, `${label} went on`);
    check(result?.attachments, kept.attachments, `${label} attachments`);
    check(result?.voice, kept.voice, `${label} voice`);
    check(
      result?.leftOut.map((file) => ({
        mimeType: file.mimeType,
        channel: file.channel,
        codes: file.issues.map((issue) => issue.code),
      })),
      expectLeft,
      `${label} left out`,
    );
  }
});
