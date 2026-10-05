import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { FIXED_CANARY } from '../../src/guardrails/corpus/canary-egress-attacks.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import {
  createOutboundProgressiveGate,
  createProgressiveYieldGate,
  DEFAULT_HOLDBACK,
} from '../../src/guardrails/progressive-yield.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import type { EgressEnforcer, GuardrailContext } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { CANARY_OPENING } from '../fixtures/canary.ts';
import { replyGate } from '../fixtures/detect.ts';

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

function ctx(canary?: string): GuardrailContext {
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: 'chat',
    ...(canary ? { canary } : {}),
  };
}

const allowAll: EgressEnforcer = () => ({ action: 'allow' });

Deno.test('createProgressiveYieldGate holds lookback then flushes safe tail', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll });
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
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  const result = await gate.process(`prefix ${canary}`);
  assertEquals(result.blocked, true);
  if (result.blocked) {
    assertEquals(
      result.hits.some((h) => h.rule === DETECT_RULES.canary_leak),
      true,
    );
  }
  assertEquals(gate.accumulated().includes(canary), true);
});

Deno.test('createProgressiveYieldGate scans only the canary without a host policy', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(mintCanary()) });
  const result = await gate.process(`key=${TEST_OPENAI_KEY} <user_data>`);
  assertEquals(result.blocked, false);
});

Deno.test('createProgressiveYieldGate holds a key a detector blocks until it settles, then stops', async () => {
  const gate = replyGate(ctx());
  // The key could still run on, so it is held, not yet a match.
  const held = await gate.process(`key=${TEST_OPENAI_KEY}`);
  assertEquals(held, { blocked: false, emit: '' });
  const result = await gate.process(' and more');
  assertEquals(result.blocked, true);
  if (result.blocked) {
    assertEquals(result.boundary, 'reply');
    assertEquals([...new Set(result.hits.map((hit) => hit.rule))], [DETECT_RULES.credentials]);
  }
});

Deno.test('createProgressiveYieldGate holdback covers split canary across chunks', async () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  const half = CANARY_OPENING;
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
    context: ctx(),
    enforce: (payload) => {
      calls++;
      if (!payload.text.includes('NOPE')) {
        return { action: 'allow' };
      }
      return {
        action: 'block',
        hits: [{ rule: 'custom', severity: 'high' }],
        rejection: 'custom rule hit',
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
    assertEquals(
      bad.hits.some((h) => h.rule === 'custom'),
      true,
    );
  }
});

Deno.test('createProgressiveYieldGate unreleased is lookback not yet emitted', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll });
  await gate.process('y'.repeat(DEFAULT_HOLDBACK + 5));
  assertEquals(gate.unreleased().length > 0, true);
  assertEquals(gate.unreleased().length <= DEFAULT_HOLDBACK, true);
  await gate.flush();
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate holds incomplete PEM until END or flush', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll });
  const begin = '-----BEGIN PRIVATE KEY-----\npartial';
  const mid = await gate.process(`${'z'.repeat(DEFAULT_HOLDBACK)}${begin}`);
  assertEquals(mid.blocked, false);
  if (!mid.blocked) {
    assertEquals(mid.emit.includes('BEGIN'), false);
  }
  assertEquals(gate.unreleased().includes('BEGIN'), true);
});

Deno.test('createProgressiveYieldGate canary-only holds just a tail that could start a leak', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  const lead = FIXED_CANARY.slice(0, 5);
  await gate.process(`${'w'.repeat(500)}${lead}`);
  assertEquals(gate.unreleased(), lead);
});

Deno.test('createProgressiveYieldGate canary-only releases at once what cannot start a leak', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  await gate.process('w'.repeat(500));
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate canary-only holds a separated opening across chunks', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  const spoken = [...FIXED_CANARY.toUpperCase()].join(' - ');
  const half = CANARY_OPENING * ' - X'.length;
  const first = await gate.process(`Sure: ${spoken.slice(0, half)}`);
  assertEquals(first, { blocked: false, emit: 'Sure: ' });
  assertEquals((await gate.process(spoken.slice(half))).blocked, true);
});

Deno.test('createProgressiveYieldGate canary-only does not hold a PEM body', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  await gate.process(`-----BEGIN PRIVATE KEY-----\n${'p'.repeat(200)}`);
  assertEquals(gate.unreleased(), '');
});

Deno.test('createProgressiveYieldGate holdback sets the enforce lookback', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll, holdback: 40 });
  await gate.process('v'.repeat(500));
  assertEquals(gate.unreleased().length, 40);
});

Deno.test('createProgressiveYieldGate holdback 0 still holds a tail that could start a leak', async () => {
  const gate = createProgressiveYieldGate({
    context: ctx(FIXED_CANARY),
    enforce: allowAll,
    holdback: 0,
  });
  const lead = FIXED_CANARY.slice(0, 4);
  await gate.process(`${'u'.repeat(500)}${lead}`);
  assertEquals(gate.unreleased(), lead);
});

Deno.test('createOutboundProgressiveGate threads egress.holdback', async () => {
  const policy = resolveGuardrailPolicy({ egress: { enforce: allowAll, holdback: 12 } });
  const gate = createOutboundProgressiveGate(policy, ctx(), 'reply');
  await gate?.process('t'.repeat(100));
  assertEquals(gate?.unreleased().length, 12);
});

Deno.test('createOutboundProgressiveGate defaults egress to DEFAULT_HOLDBACK', async () => {
  const policy = resolveGuardrailPolicy({ egress: { enforce: allowAll } });
  const gate = createOutboundProgressiveGate(policy, ctx(mintCanary()), 'reply');
  await gate?.process('s'.repeat(DEFAULT_HOLDBACK * 2));
  assertEquals(gate?.unreleased().length, DEFAULT_HOLDBACK);
});

const PEM_HEAD = '-----BEGIN PRIVATE KEY-----';

Deno.test('an open PEM body is held from its BEGIN, however small the holdback', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll, holdback: 4 });
  const first = await gate.process(`safe text ${PEM_HEAD}\nAAAA\nBBBB\n`);
  assertEquals(first, { blocked: false, emit: 'safe text ' });
  const second = await gate.process('CCCC\n');
  assertEquals(second, { blocked: false, emit: '' });
});

Deno.test('a PEM body that opens the text is held whole', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll, holdback: 4 });
  assertEquals(await gate.process(`${PEM_HEAD}\nAAAA\nBBBB\n`), { blocked: false, emit: '' });
});

Deno.test('a closed PEM body is released down to the holdback, with or without RSA', async () => {
  for (const kind of ['', 'RSA ']) {
    const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll, holdback: 4 });
    const text = `-----BEGIN ${kind}PRIVATE KEY-----\nAAAA\n-----END ${kind}PRIVATE KEY-----\nthen more words`;
    const result = await gate.process(text);
    check(result, { blocked: false, emit: text.slice(0, text.length - 4) }, kind);
  }
});

Deno.test('an END that comes before a later BEGIN does not close it', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll, holdback: 4 });
  const result = await gate.process(
    `-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nplain ${PEM_HEAD}\nBBBB\n`,
  );
  assertEquals(result.blocked, false);
  if (!result.blocked) {
    assertEquals(result.emit.endsWith('plain '), true);
    assertEquals(result.emit.includes('BBBB'), false);
  }
});

Deno.test('a host enforcer that stops the stream is judged by its action and its own hits', async () => {
  const own = { rule: 'host.rule', severity: 'high' as const };
  const verdicts = (hits: (typeof own)[]): EgressEnforcer[] => [
    () => ({ action: 'block', hits, rejection: 'no' }),
    () => ({ action: 'redact', hits, text: 'x' }),
  ];
  for (const enforce of verdicts([own])) {
    const gate = createProgressiveYieldGate({ context: ctx(), enforce });
    assertEquals(await gate.process('text'), { blocked: true, hits: [own] });
  }
  for (const enforce of verdicts([])) {
    const gate = createProgressiveYieldGate({ context: ctx(), enforce });
    assertEquals(await gate.process('text'), {
      blocked: true,
      hits: [{ rule: EGRESS_RULES.blocked, severity: 'high' }],
    });
  }
  const flagged = createProgressiveYieldGate({
    context: ctx(),
    enforce: () => ({ action: 'flag', hits: [own] }),
    holdback: 0,
  });
  assertEquals(await flagged.process('text'), { blocked: false, emit: 'text' });
});

Deno.test('an empty fragment is neither scanned nor released', async () => {
  let scans = 0;
  const gate = createProgressiveYieldGate({
    context: ctx(),
    enforce: () => {
      scans++;
      return { action: 'allow' };
    },
    holdback: 0,
  });
  assertEquals(await gate.process(''), { blocked: false, emit: '' });
  assertEquals(scans, 0);
  assertEquals(await gate.process('x'), { blocked: false, emit: 'x' });
  assertEquals(scans, 1);
});

Deno.test('a canary-shaped tail is held from where it begins in the unreleased text', async () => {
  const canary = mintCanary();
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(await gate.process('w'.repeat(50)), { blocked: false, emit: 'w'.repeat(50) });
  assertEquals(await gate.process(canary.slice(0, 4)), { blocked: false, emit: '' });
  assertEquals(gate.unreleased(), canary.slice(0, 4));
});

Deno.test('draining the unreleased tail takes only what was not yet released, and flush then adds nothing', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(), enforce: allowAll, holdback: 4 });
  assertEquals(await gate.process('abcdefghij'), { blocked: false, emit: 'abcdef' });
  assertEquals(gate.drainUnreleased(), 'ghij');
  assertEquals(gate.unreleased(), '');
  assertEquals(await gate.flush(), { blocked: false, emit: '' });
  assertEquals(gate.accumulated(), 'abcdefghij');
});

Deno.test('createProgressiveYieldGate reads the carry in front of its window', async () => {
  const canary = mintCanary();
  const half = CANARY_OPENING;
  const first = createProgressiveYieldGate({ context: ctx(canary) });
  // No letters or digits in the lead-in: they could extend the opening in some reading.
  assertEquals(await first.process(`>> ${canary.slice(0, half)}`), {
    blocked: false,
    emit: '>> ',
  });
  assertEquals((await first.flush()).blocked, false);
  // The next window of the same canary completes the token: one match.
  const second = createProgressiveYieldGate({ context: ctx(canary), carry: first.carryOut() });
  assertEquals((await second.process(canary.slice(half))).blocked, true);
});

Deno.test('createProgressiveYieldGate holds a window opening that continues the carry', async () => {
  const canary = 'abcdef0123456789abcdef0123456789';
  const gate = createProgressiveYieldGate({ context: ctx(canary), carry: 'abcdef' });
  // "0123" continues the carried opening, so it is held; "5" breaks it, so "zz, 5" goes.
  assertEquals(await gate.process('0123'), { blocked: false, emit: '' });
  const other = createProgressiveYieldGate({ context: ctx(canary), carry: 'abcdef' });
  assertEquals(await other.process('zz, 5'), { blocked: false, emit: 'zz, 5' });
});

Deno.test('createProgressiveYieldGate carries only the tail that could open a leak', async () => {
  const gate = createProgressiveYieldGate({ context: ctx(FIXED_CANARY) });
  await gate.process('nothing to carry here');
  assertEquals(gate.carryOut(), 're');
  assertEquals(createProgressiveYieldGate({ context: ctx() }).carryOut(), '');
});

Deno.test('createProgressiveYieldGate releases a three-character opening and blocks the leak it grows into', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  // Shorter than an opening the hold keeps back: it goes out.
  assertEquals(await gate.process(`Here: ${canary.slice(0, 3)}`), {
    blocked: false,
    emit: `Here: ${canary.slice(0, 3)}`,
  });
  // The rest of the token still reads as one leak with what was released.
  const next = await gate.process(canary.slice(3));
  assertEquals(next.blocked, true);
});

Deno.test('createProgressiveYieldGate holds a four-character opening', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const gate = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(await gate.process(`Here: ${canary.slice(0, 4)}`), {
    blocked: false,
    emit: 'Here: ',
  });
  assertEquals((await gate.process(canary.slice(4))).blocked, true);
});

Deno.test('createProgressiveYieldGate carries a released short opening into the next window', async () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  const first = createProgressiveYieldGate({ context: ctx(canary) });
  assertEquals(await first.process(`Here: ${canary.slice(0, 3)}`), {
    blocked: false,
    emit: `Here: ${canary.slice(0, 3)}`,
  });
  assertEquals(await first.flush(), { blocked: false, emit: '' });
  // Three released characters and fifteen more make one sixteen-character run.
  const next = createProgressiveYieldGate({ context: ctx(canary), carry: first.carryOut() });
  assertEquals((await next.process(canary.slice(3, 18))).blocked, true);
});
