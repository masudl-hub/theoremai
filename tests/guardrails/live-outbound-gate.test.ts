import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { PUBLIC_CANARY } from '../../src/guardrails/error.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { EgressContext, EgressEnforcementResult, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModel } from '../fixtures/models.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function chatProfile() {
  return getProfile('chat');
}

function session(canary?: string) {
  return createLiveOutboundGateSession(chatProfile(), canary);
}

// ── createLiveOutboundGateSession ─────────────────────────────────────────────

Deno.test('createLiveOutboundGateSession: canary gate is null when no canary supplied', () => {
  const s = session();
  assertEquals(s.gate, null);
  assertEquals(s.canary, undefined);
});

Deno.test('createLiveOutboundGateSession: gate is created when canary is supplied', () => {
  const canary = mintCanary();
  const s = session(canary);
  assertEquals(s.canary, canary);
  assertEquals(s.gate !== null, true);
});

Deno.test('createLiveOutboundGateSession: holdUserVisible is false when egress has no enforce', () => {
  assertEquals(session(mintCanary()).holdUserVisible, false);
});

// ── processLiveOutboundBatch — basic streaming ────────────────────────────────

Deno.test('processLiveOutboundBatch emits safe text chunks without a canary gate', () => {
  const s = session();
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.text, 'hello');
  }
});

Deno.test('processLiveOutboundBatch emits safe long text chunk through the gate', () => {
  const canary = mintCanary();
  const s = session(canary);
  const longText = 'safe text '.repeat(20);
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: longText }]);
  // gate may buffer the tail (overlap window) but should emit something
  assertEquals(result.action === 'emit' || result.action === 'idle', true);
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a stream event', () => {
  const canary = mintCanary();
  const s = session(canary);
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: canary }]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
  }
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a non-stream event', () => {
  const canary = mintCanary();
  const s = session(canary);
  const events: TurnEvent[] = [{ type: 'error', error: canary }];
  const result = processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch passes non-stream events without canary', () => {
  const s = session(mintCanary());
  const result = processLiveOutboundBatch(s, [{ type: 'done' }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.type, 'done');
  }
});

Deno.test('processLiveOutboundBatch returns idle for empty event list', () => {
  const s = session(mintCanary());
  assertEquals(processLiveOutboundBatch(s, []).action, 'idle');
});

Deno.test('processLiveOutboundBatch flushes canary tail on stream-type transition', () => {
  const canary = mintCanary();
  const s = session(canary);
  // Send a text event first, then a thought event — triggers type-switch flush
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = processLiveOutboundBatch(s, [{ type: 'thought', text: 'thinking' }]);
  // Should emit or idle but not withhold
  assertEquals(result.action !== 'withhold', true);
});

Deno.test('processLiveOutboundBatch withholds when non-stream event follows a pending gate tail with canary', () => {
  const canary = mintCanary();
  const s = session(canary);
  // seed the gate with the beginning of the canary so there's a pending tail
  processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, 5) }]);
  // Now the gate has 'lastStreamType' set; force a flush by sending a non-stream event
  // while also completing the canary in the pending buffer by sending the rest
  const events: TurnEvent[] = [{ type: 'text', text: canary.slice(5) }, { type: 'done' }];
  const result = processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

// ── processLiveOutboundBatch — holdUserVisible (egress.enforce) ───────────────

Deno.test('processLiveOutboundBatch buffers visible events when holdUserVisible is true', async () => {
  let enforced = false;
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_hold',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => {
            enforced = true;
            return { blocked: false, text: ctx.text };
          },
        },
      },
    }),
  );
  const profile = getProfile('live_egress_hold');
  // No canary — gate is null, so text goes directly into the egress hold buffer
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.holdUserVisible, true);

  // Events should be buffered, not emitted
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'answer' }]);
  assertEquals(result.action, 'idle');
  assertEquals(s.pendingVisible.length > 0, true);
  assertEquals(enforced, false);

  // Finalize releases them
  const final = await finalizeLiveOutboundTurn(s);
  assertEquals(enforced, true);
  assertEquals(final.action, 'emit');
});

Deno.test('finalizeLiveOutboundTurn withholds when egress.enforce blocks', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_block',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (_ctx: EgressContext): EgressEnforcementResult => ({
            blocked: true,
            text: '',
            hits: ['injection_echo'],
            rejectionMessage: 'blocked',
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_egress_block');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user text when onBlock is set', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_refuse',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          onBlock: 'refuse_to_user',
          enforce: (_ctx: EgressContext): EgressEnforcementResult => ({
            blocked: true,
            text: 'That reply was blocked.',
            hits: ['canary'],
            rejectionMessage: 'blocked',
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_egress_refuse');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.text, 'That reply was blocked.');
  }
});

// ── finalizeLiveOutboundTurn — no egress hold ─────────────────────────────────

Deno.test('finalizeLiveOutboundTurn flushes canary gate tail on finalize', async () => {
  const canary = mintCanary();
  const s = session(canary);
  // 'prefix ' is shorter than the overlap window (canary.length - 1), so the gate
  // holds all of it; finalize must flush and emit it
  processLiveOutboundBatch(s, [{ type: 'text', text: 'prefix ' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const text = result.events.map((e) => e.text ?? '').join('');
    assertEquals(text.includes('prefix'), true);
  }
});

Deno.test('finalizeLiveOutboundTurn returns idle when there is nothing to emit', async () => {
  const s = session(mintCanary());
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('finalizeLiveOutboundTurn withholds when flushed canary tail leaks', () => {
  const canary = mintCanary();
  const s = session(canary);
  // fill the gate's pending buffer with the whole canary by splitting it
  const half = Math.ceil(canary.length / 2);
  processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, half) }]);
  // send the second half — gate detects the leak
  const result2 = processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(result2.action, 'withhold');
});

// ── abortLiveOutboundTurn ────────────────────────────────────────────────────

Deno.test('abortLiveOutboundTurn clears accumulated state and resets the gate', () => {
  const canary = mintCanary();
  const s = session(canary);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'partial answer' }]);
  s.accumulatedText = 'partial answer';
  abortLiveOutboundTurn(s);
  assertEquals(s.pendingVisible.length, 0);
  assertEquals(s.accumulatedText, '');
  assertEquals(s.lastStreamType, undefined);
  assertEquals(s.gate !== null, true);
});

Deno.test('abortLiveOutboundTurn without canary does not recreate gate', () => {
  const s = session();
  abortLiveOutboundTurn(s);
  assertEquals(s.gate, null);
});

Deno.test('processLiveOutboundBatch returns idle when all text is held in the gate overlap buffer', () => {
  const canary = mintCanary();
  const s = session(canary);
  // 'hi' is much shorter than the overlap window (canary.length - 1 ≈ 37)
  // so the gate emits nothing → action must be idle
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'hi' }]);
  assertEquals(result.action, 'idle');
});

Deno.test('processLiveOutboundBatch with holdUserVisible buffers thought events too', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_hold_thought',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_egress_hold_thought');
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.holdUserVisible, true);
  const result = processLiveOutboundBatch(s, [{ type: 'thought', text: 'inner reasoning' }]);
  // thought events are also user-visible and must be buffered
  assertEquals(result.action, 'idle');
  assertEquals(s.pendingVisible.length, 1);
});

Deno.test('createLiveOutboundGateSession with canary=false profile ignores provided canary', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_canary_disabled',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, canary: false },
    }),
  );
  const profile = getProfile('live_canary_disabled');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  assertEquals(s.gate, null);
  assertEquals(s.canary, undefined);
});

Deno.test('createLiveOutboundGateSession with canary=true profile but no canary string leaves gate null', () => {
  const s = session();
  assertEquals(s.gate, null);
  assertEquals(s.canary, undefined);
});

Deno.test('flushCanaryTail action is idle not empty object when gate is null', async () => {
  const s = session();
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('appendVisibleText skips non-text and non-thought events (type filter)', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_type_filter',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_type_filter');
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.holdUserVisible, true);
  // 'done' is not text/thought — should NOT be appended to pendingVisible
  processLiveOutboundBatch(s, [{ type: 'done' }]);
  assertEquals(s.pendingVisible.length, 0);
});

Deno.test('appendVisibleText only accumulates non-empty text not undefined/empty', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_text_gate',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_text_gate');
  const s = createLiveOutboundGateSession(profile);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(s.accumulatedText, 'hello');
});

Deno.test('finalizeLiveOutboundTurn action and events correct when pending visible with no egress enforce', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_hold_no_egress',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_hold_no_egress');
  const s = createLiveOutboundGateSession(profile);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'response content' }]);
  assertEquals(s.pendingVisible.length > 0, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events.length > 0, true);
    assertEquals(
      result.events.some((e) => e.text === 'response content'),
      true,
    );
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user event type is text not empty', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_refuse_type_check',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          onBlock: 'refuse_to_user',
          enforce: (_ctx: EgressContext): EgressEnforcementResult => ({
            blocked: true,
            text: 'Sorry, that was blocked.',
            hits: ['canary'],
            rejectionMessage: 'blocked',
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_refuse_type_check');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  processLiveOutboundBatch(s, [{ type: 'text', text: 'partial' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.type, 'text');
  }
});

Deno.test('finalizeLiveOutboundTurn onBlock=refuse_to_user requires both condition parts', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_refuse_both_parts',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          // onBlock not set — defaults to withhold behavior
          enforce: (_ctx: EgressContext): EgressEnforcementResult => ({
            blocked: true,
            text: 'should not be shown',
            hits: ['canary'],
            rejectionMessage: 'blocked',
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_refuse_both_parts');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  processLiveOutboundBatch(s, [{ type: 'text', text: 'partial' }]);
  const result = await finalizeLiveOutboundTurn(s);
  // Without onBlock='refuse_to_user', blocked turn should withhold, not emit the text
  assertEquals(result.action, 'withhold');
});

Deno.test('abortLiveOutboundTurn resets accumulatedText to empty string not placeholder', () => {
  const s = session(mintCanary());
  s.accumulatedText = 'some text';
  abortLiveOutboundTurn(s);
  assertEquals(s.accumulatedText, '');
});

Deno.test('processLiveOutboundBatch emitType in flush is text string when lastStreamType is text', async () => {
  const canary = mintCanary();
  const s = session(canary);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'a'.repeat(50) }]);
  const result = await finalizeLiveOutboundTurn(s);
  if (result.action === 'emit') {
    assertEquals(
      result.events.every((e) => e.type === 'text' || e.type === 'thought'),
      true,
    );
  }
});

Deno.test('processLiveOutboundBatch emits non-visible event types immediately even with holdUserVisible', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_nonvis',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_egress_nonvis');
  const s = createLiveOutboundGateSession(profile);
  // 'tokens' and 'done' are not visible types — they pass through immediately
  const result = processLiveOutboundBatch(s, [
    { type: 'tokens', tokens: { input: 1, output: 1, total: 2 } },
    { type: 'done' },
  ]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events.length, 2);
  }
  assertEquals(s.pendingVisible.length, 0);
});

// ── appendVisibleText: if (event.text) guard (line 58) ───────────────────────

Deno.test('appendVisibleText does not accumulate when text field is absent', () => {
  // Uses holdUserVisible profile so appendVisibleText is called via holdUserVisible path
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_no_text_field',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_no_text_field');
  const s = createLiveOutboundGateSession(profile);
  // Send a text event with no text field — accumulatedText must stay empty
  processLiveOutboundBatch(s, [{ type: 'text' }]);
  assertEquals(s.accumulatedText, '');
});

// ── processStreamChunk with gate + holdUserVisible (lines 113-115) ────────────

Deno.test('processStreamChunk with gate and holdUserVisible buffers emitted content', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_gate_hold',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        canary: true,
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => ({
            blocked: false,
            text: ctx.text,
          }),
        },
      },
    }),
  );
  const profile = getProfile('live_gate_hold');
  const canary = mintCanary();
  const s = createLiveOutboundGateSession(profile, canary);
  assertEquals(s.holdUserVisible, true);
  assertEquals(s.gate !== null, true);
  // Send long content the gate will emit (> overlap window)
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'a'.repeat(100) }]);
  // With gate + holdUserVisible: must buffer (idle), not emit directly
  assertEquals(result.action, 'idle');
  assertEquals(s.pendingVisible.length > 0, true);
  assertEquals(s.accumulatedText.length > 0, true);
});

// ── processStreamChunk with gate + no holdUserVisible (lines 117) ─────────────

Deno.test('processStreamChunk with gate and no holdUserVisible emits content directly', () => {
  const canary = mintCanary();
  const s = session(canary);
  assertEquals(s.holdUserVisible, false);
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: 'a'.repeat(100) }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events.length > 0, true);
    const text = result.events.map((e) => e.text ?? '').join('');
    assertEquals(text.length > 0, true);
  }
});

// ── flushCanaryTail with empty pending → idle (lines 74-75) ──────────────────

Deno.test('finalizeLiveOutboundTurn is idle when gate pending is empty after empty-text event', async () => {
  // Scenario: empty text event sets lastStreamType without filling pending buffer
  const canary = mintCanary();
  const s = session(canary);
  // Empty text: gate.process('') returns {leak:false, emit:''} without touching pending
  // but lastStreamType gets set to 'text', so flushCanaryTailInto will call flushCanaryTail
  processLiveOutboundBatch(s, [{ type: 'text', text: '' }]);
  assertEquals(s.lastStreamType, 'text');
  const result = await finalizeLiveOutboundTurn(s);
  // flush() on empty pending returns emit:'', so flushCanaryTail must return idle, not emit
  assertEquals(result.action, 'idle');
});

// ── finalizeLiveOutboundTurn with holdUserVisible + no content (line 203) ─────

Deno.test('finalizeLiveOutboundTurn is idle when holdUserVisible but nothing buffered', async () => {
  // When pendingVisible is empty, should return idle (or emit extra if extra is also empty)
  const profile = getProfile('live_egress_hold');
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.holdUserVisible, true);
  assertEquals(s.pendingVisible.length, 0);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

// ── finalizeLiveOutboundTurn clears session state (lines 209-210) ─────────────

Deno.test('finalizeLiveOutboundTurn clears pendingVisible after processing', async () => {
  const profile = getProfile('live_egress_hold');
  const s = createLiveOutboundGateSession(profile);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'content' }]);
  assertEquals(s.pendingVisible.length > 0, true);
  await finalizeLiveOutboundTurn(s);
  assertEquals(s.pendingVisible.length, 0);
});

Deno.test('finalizeLiveOutboundTurn clears accumulatedText after processing', async () => {
  const profile = getProfile('live_egress_hold');
  const s = createLiveOutboundGateSession(profile);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'content' }]);
  assertEquals(s.accumulatedText, 'content');
  await finalizeLiveOutboundTurn(s);
  assertEquals(s.accumulatedText, '');
});

// ── finalizeLiveOutboundTurn: enforce called with ctx.text (line 217) ─────────

Deno.test('finalizeLiveOutboundTurn passes accumulated text to egress enforce ctx', async () => {
  // Enforce that throws when ctx.text is missing/undefined
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_ctx_verify',
      model: { ...geminiModel('gemini35FlashLite') },
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        egress: {
          enforce: (ctx: EgressContext): EgressEnforcementResult => {
            if (typeof ctx.text !== 'string') throw new Error('ctx.text missing');
            return { blocked: false, text: ctx.text };
          },
        },
      },
    }),
  );
  const profile = getProfile('live_egress_ctx_verify');
  const s = createLiveOutboundGateSession(profile);
  processLiveOutboundBatch(s, [{ type: 'text', text: 'response content' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
});

// ── abortLiveOutboundTurn: gate reset prevents stale canary prefix (line 239) ─

Deno.test('abortLiveOutboundTurn resets gate so canary prefix does not persist', () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = Math.ceil(canary.length / 2);
  // Seed gate with first half of canary — pending now holds prefix
  processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, half) }]);
  // Abort must reset gate (clear pending)
  abortLiveOutboundTurn(s);
  // Send second half — with reset gate, not detected as a canary leak
  const result = processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(result.action !== 'withhold', true);
});

// ── processStreamChunk type-switch: if(true) guard at 99:9 kills thought processing

Deno.test('processLiveOutboundBatch type switch delivers thought content after text', async () => {
  const canary = mintCanary();
  const s = session(canary);
  // Send long text (fills pending with safe content)
  processLiveOutboundBatch(s, [{ type: 'text', text: 'a'.repeat(100) }]);
  // Send thought — triggers type-switch flush then processes thought
  processLiveOutboundBatch(s, [{ type: 'thought', text: 'b'.repeat(100) }]);
  // Finalize flushes any remaining content
  const result = await finalizeLiveOutboundTurn(s);
  // Some content from thought must have been emitted or held — not a permanent withhold
  assertEquals(result.action !== 'withhold', true);
});
