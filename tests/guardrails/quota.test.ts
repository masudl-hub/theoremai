import '../fixtures/test-host.ts';
import {
  clientIp,
  quotaMessage,
  releaseSlot,
  resetSlots,
  skipQuota,
  takeSlot,
} from '../../src/guardrails/quota.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, getProfile } from '../../src/kernel/registry/profiles.ts';
import { geminiModel } from '../fixtures/models.ts';

const now = Date.parse('2026-08-16T12:00:00Z');
const ip = '203.0.113.10';

Deno.test('skipQuota is true only for a loopback peer without CF', () => {
  const req = new Request('http://example.com/', { method: 'POST' });
  assertEquals(skipQuota('127.0.0.1', req), true);
  assertEquals(skipQuota('::1', req), true);
});

Deno.test('skipQuota ignores a localhost Host when the peer is not loopback', () => {
  const req = new Request('http://localhost:8002/', { method: 'POST' });
  assertEquals(skipQuota('8.8.8.8', req), false);
});

Deno.test('skipQuota is false for loopback behind Cloudflare', () => {
  const req = new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  });
  assertEquals(skipQuota('127.0.0.1', req), false);
});

Deno.test('clientIp uses the socket peer and ignores x-forwarded-for', () => {
  const req = new Request('http://example.com/', {
    headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' },
  });
  assertEquals(clientIp(ip, req), ip);
  assertEquals(clientIp('', new Request('http://example.com/')), 'unknown');
});

Deno.test('clientIp uses cf-connecting-ip only when the peer is loopback', () => {
  const req = new Request('http://example.com/', {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '9.9.9.9' },
  });
  assertEquals(clientIp('127.0.0.1', req), '203.0.113.9');
  assertEquals(clientIp('198.51.100.2', req), '198.51.100.2');

  // Release non-existent slot does not throw
  releaseSlot(getProfile('image'), 'non-existent-ip');
});

Deno.test('takeSlot is one inflight and perDay on that profile', () => {
  resetSlots();
  const imageProfile = getProfile('image');
  assertEquals(takeSlot(imageProfile, ip, now), 'ok');
  assertEquals(takeSlot(imageProfile, ip, now), 'busy');
  releaseSlot(imageProfile, ip);
  assertEquals(takeSlot(imageProfile, ip, now), 'ok');
  releaseSlot(imageProfile, ip);
  takeSlot(imageProfile, ip, now);
  releaseSlot(imageProfile, ip);
  takeSlot(imageProfile, ip, now);
  releaseSlot(imageProfile, ip);
  assertEquals(takeSlot(imageProfile, ip, now), 'quota');
});

Deno.test('takeSlot returns not_configured when profile omits quota', () => {
  const profile = defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    tools: { allow: [] },
    inputs: { text: true },
    id: 'unmetered',
    model: { ...geminiModel('gemini35FlashLite') },
  });

  assertEquals(takeSlot(profile, ip, now), 'not_configured');
});

Deno.test('profile quotas do not share a bucket', () => {
  resetSlots();
  const imageProfile = getProfile('image');
  const chatProfile = getProfile('chat');
  assertEquals(takeSlot(imageProfile, ip, now), 'ok');
  releaseSlot(imageProfile, ip);
  takeSlot(imageProfile, ip, now);
  releaseSlot(imageProfile, ip);
  takeSlot(imageProfile, ip, now);
  releaseSlot(imageProfile, ip);
  takeSlot(imageProfile, ip, now);
  releaseSlot(imageProfile, ip);
  assertEquals(takeSlot(imageProfile, ip, now), 'quota');
  assertEquals(takeSlot(chatProfile, ip, now), 'ok');
  releaseSlot(chatProfile, ip);
});

Deno.test('quotaMessage names the profile handle', () => {
  assertEquals(quotaMessage(getProfile('image')), "Enjoying image? You've reached today's limit");
});

Deno.test('takeSlot resets count on a new UTC day', () => {
  resetSlots();
  const profile = getProfile('image');
  const ip = '10.0.0.99';
  const day1 = Date.parse('2026-01-01T12:00:00Z');
  const day2 = Date.parse('2026-01-02T12:00:00Z');

  // exhaust the day-1 quota (perDay = 4 for image profile)
  takeSlot(profile, ip, day1);
  releaseSlot(profile, ip);
  takeSlot(profile, ip, day1);
  releaseSlot(profile, ip);
  takeSlot(profile, ip, day1);
  releaseSlot(profile, ip);
  takeSlot(profile, ip, day1);
  releaseSlot(profile, ip);
  assertEquals(takeSlot(profile, ip, day1), 'quota');

  // day 2 resets the bucket
  assertEquals(takeSlot(profile, ip, day2), 'ok');
  releaseSlot(profile, ip);
});

Deno.test('clientIp returns unknown for empty peer string', () => {
  assertEquals(clientIp('', new Request('http://x.com/')), 'unknown');
});

Deno.test('clientIp ignores x-forwarded-for when peer is not loopback', () => {
  const req = new Request('http://x.com/', { headers: { 'x-forwarded-for': '9.9.9.9' } });
  assertEquals(clientIp('203.0.113.5', req), '203.0.113.5');
});

Deno.test('skipQuota is true for localhost string in LOOPBACK set', () => {
  const req = new Request('http://localhost/', { method: 'POST' });
  assertEquals(skipQuota('localhost', req), true);
});

Deno.test('clientIp for loopback without CF header returns the loopback peer not empty string', () => {
  const req = new Request('http://127.0.0.1/');
  assertEquals(clientIp('127.0.0.1', req), '127.0.0.1');
});

Deno.test('clientIp trims whitespace from cf-connecting-ip header', () => {
  const req = new Request('http://127.0.0.1/', {
    headers: { 'cf-connecting-ip': '  203.0.113.20  ' },
  });
  assertEquals(clientIp('127.0.0.1', req), '203.0.113.20');
});

Deno.test('takeSlot uses a per-profile-and-ip key so different IPs on same profile are independent', () => {
  resetSlots();
  const profile = getProfile('image');
  const ipA = '10.0.0.1';
  const ipB = '10.0.0.2';
  const ts = Date.parse('2026-08-16T12:00:00Z');
  assertEquals(takeSlot(profile, ipA, ts), 'ok');
  assertEquals(takeSlot(profile, ipB, ts), 'ok');
  releaseSlot(profile, ipA);
  releaseSlot(profile, ipB);
  resetSlots();
});

Deno.test('takeSlot day key is a 10-character YYYY-MM-DD string not the full ISO timestamp', () => {
  resetSlots();
  const profile = getProfile('image');
  const ip2 = '10.1.1.1';
  const morning = Date.parse('2026-08-16T00:00:00Z');
  const evening = Date.parse('2026-08-16T23:59:59Z');
  // Both same UTC day — should share the same slot (second call 'busy', not re-ok'd)
  assertEquals(takeSlot(profile, ip2, morning), 'ok');
  assertEquals(takeSlot(profile, ip2, evening), 'busy');
  releaseSlot(profile, ip2);
  resetSlots();
});
