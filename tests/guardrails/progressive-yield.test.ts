import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import {
  createProgressiveYieldGate,
  DEFAULT_HOLDBACK,
} from '../../src/guardrails/progressive-yield.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { getProfile } from '../../src/kernel/registry/profiles.ts';

Deno.test('createProgressiveYieldGate holds lookback then flushes safe tail', async () => {
  const gate = createProgressiveYieldGate();
  const body = `${'x'.repeat(DEFAULT_HOLDBACK + 10)}ok`;
  const mid = await gate.process(body);
  assertEquals(mid.blocked, false);
  if (!mid.blocked) {
    assertEquals(mid.emit.length > 0, true);
    assertEquals(mid.emit.endsWith('ok'), false);
  }
  const end = await gate.flush();
  assertEquals(end.blocked, false);
  if (!end.blocked) {
    assertEquals(end.emit.includes('ok'), true);
  }
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate blocks canary before release', async () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ canary });
  const result = await gate.process(`prefix ${canary}`);
  assertEquals(result.blocked, true);
  if (result.blocked) {
    assertEquals(result.hits.includes('canary'), true);
  }
  assertEquals(gate.accumulated().includes(canary), true);
});

Deno.test('createProgressiveYieldGate blocks sensitive spans via bundled policy', async () => {
  const gate = createProgressiveYieldGate();
  const result = await gate.process(`key=${TEST_OPENAI_KEY}`);
  assertEquals(result.blocked, true);
  if (result.blocked) {
    assertEquals(result.hits.includes('sensitive'), true);
  }
});

Deno.test('createProgressiveYieldGate holdback covers split canary across chunks', async () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ canary });
  const half = Math.ceil(canary.length / 2);
  const first = await gate.process(canary.slice(0, half));
  assertEquals(first.blocked, false);
  if (!first.blocked) {
    assertEquals(first.emit, '');
  }
  const second = await gate.process(canary.slice(half));
  assertEquals(second.blocked, true);
});

Deno.test('createProgressiveYieldGate runs host enforce before emit (no double bundled scan)', async () => {
  let calls = 0;
  const gate = createProgressiveYieldGate({
    profile: getProfile('chat'),
    enforce: (ctx) => {
      calls++;
      return {
        blocked: ctx.text.includes('NOPE'),
        text: ctx.text,
        hits: ctx.text.includes('NOPE') ? ['custom'] : undefined,
      };
    },
  });
  const ok = await gate.process('safe '.repeat(80));
  assertEquals(ok.blocked, false);
  assertEquals(calls > 0, true);
  // Host enforce passed; bundled sensitive/injection is not re-applied.
  const key = await gate.process(` key=${TEST_OPENAI_KEY}`);
  assertEquals(key.blocked, false);
  const bad = await gate.process('NOPE');
  assertEquals(bad.blocked, true);
  if (bad.blocked) {
    assertEquals(bad.hits.includes('custom'), true);
  }
});

Deno.test('createProgressiveYieldGate unreleased is lookback not yet emitted', async () => {
  const gate = createProgressiveYieldGate();
  await gate.process('y'.repeat(DEFAULT_HOLDBACK + 5));
  assertEquals(gate.unreleased().length > 0, true);
  assertEquals(gate.unreleased().length <= DEFAULT_HOLDBACK, true);
  await gate.flush();
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate holds incomplete PEM until END or flush', async () => {
  const gate = createProgressiveYieldGate();
  const begin = '-----BEGIN PRIVATE KEY-----\npartial';
  const mid = await gate.process(`${'z'.repeat(DEFAULT_HOLDBACK)}${begin}`);
  assertEquals(mid.blocked, false);
  if (!mid.blocked) {
    assertEquals(mid.emit.includes('BEGIN'), false);
  }
  assertEquals(gate.unreleased().includes('BEGIN'), true);
});
