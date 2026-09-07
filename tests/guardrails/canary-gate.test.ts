import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import {
  createCanaryGateSession,
  filterCanaryGatedEvents,
} from '../../src/guardrails/canary-gate.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

Deno.test('createCanaryGateSession initializes canary and gate', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  assertEquals(session.canary, canary);
  assertEquals(typeof session.gate.process, 'function');
  assertEquals(typeof session.gate.flush, 'function');
  assertEquals(session.lastStreamType, undefined);
});

Deno.test('filterCanaryGatedEvents passes non-streaming events without canary', () => {
  const session = createCanaryGateSession(mintCanary());
  const events: TurnEvent[] = [{ type: 'done' }, { type: 'error', error: 'something' }];
  const result = filterCanaryGatedEvents(session, events);
  assertEquals(result.leaked, false);
  if (!result.leaked) {
    assertEquals(result.events.length, 2);
  }
});

Deno.test('filterCanaryGatedEvents signals leaked when a non-streaming event contains the canary', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  const events: TurnEvent[] = [{ type: 'error', error: canary }];
  assertEquals(filterCanaryGatedEvents(session, events).leaked, true);
});

Deno.test('filterCanaryGatedEvents emits safe text from streaming events', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  // Use text long enough that the gate's overlap window releases some of it
  const longSafe = 'hello world '.repeat(10);
  const events: TurnEvent[] = [{ type: 'text', text: longSafe }];
  const result = filterCanaryGatedEvents(session, events);
  assertEquals(result.leaked, false);
  if (!result.leaked) {
    const combined = result.events.map((e) => e.text ?? '').join('');
    assertEquals(combined.includes('hello'), true);
  }
});

Deno.test('filterCanaryGatedEvents sets lastStreamType on the session', () => {
  const session = createCanaryGateSession(mintCanary());
  assertEquals(session.lastStreamType, undefined);
  filterCanaryGatedEvents(session, [{ type: 'thought', text: 'thinking...' }]);
  assertEquals(session.lastStreamType, 'thought');
  filterCanaryGatedEvents(session, [{ type: 'text', text: 'reply' }]);
  assertEquals(session.lastStreamType, 'text');
});

Deno.test('filterCanaryGatedEvents stops immediately on a canary leak in a stream event', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  const events: TurnEvent[] = [
    { type: 'text', text: canary },
    { type: 'text', text: 'text after leak' },
  ];
  assertEquals(filterCanaryGatedEvents(session, events).leaked, true);
});

Deno.test('filterCanaryGatedEvents suppresses empty-emit text events', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  // Feed almost all of the canary — gate buffers it (overlap window), emitting nothing
  const almost = canary.slice(0, canary.length - 1);
  const result = filterCanaryGatedEvents(session, [{ type: 'text', text: almost }]);
  assertEquals(result.leaked, false);
  if (!result.leaked) {
    assertEquals(result.events.length, 0);
  }
});

Deno.test('filterCanaryGatedEvents handles an empty event list', () => {
  const session = createCanaryGateSession(mintCanary());
  const result = filterCanaryGatedEvents(session, []);
  assertEquals(result.leaked, false);
  if (!result.leaked) {
    assertEquals(result.events.length, 0);
  }
});

Deno.test('filterCanaryGatedEvents handles thought-type streaming event', () => {
  const canary = mintCanary();
  const session = createCanaryGateSession(canary);
  const result = filterCanaryGatedEvents(session, [{ type: 'thought', text: 'safe thinking' }]);
  assertEquals(result.leaked, false);
  assertEquals(session.lastStreamType, 'thought');
});

Deno.test('filterCanaryGatedEvents detects canary at every chunk partition boundary', () => {
  const canary = mintCanary();
  for (let splitIdx = 1; splitIdx < canary.length; splitIdx++) {
    const session = createCanaryGateSession(canary);
    const first = filterCanaryGatedEvents(session, [
      { type: 'text', text: canary.slice(0, splitIdx) },
    ]);
    const second = filterCanaryGatedEvents(session, [
      { type: 'text', text: canary.slice(splitIdx) },
    ]);
    if (!(first.leaked || second.leaked)) {
      throw new Error(`canary leak missed at split index ${splitIdx}`);
    }
  }
});
