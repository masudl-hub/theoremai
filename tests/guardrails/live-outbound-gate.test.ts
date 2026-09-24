import '../fixtures/test-host.ts';
import { canaryLeakSpan, mintCanary } from '../../src/guardrails/canary.ts';
import { PUBLIC_CANARY } from '../../src/guardrails/error.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { DEFAULT_HOLDBACK } from '../../src/guardrails/progressive-yield.ts';
import type { EgressEnforcer, Verdict } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function chatProfile() {
  return getProfile('chat');
}

function session(canary?: string) {
  return createLiveOutboundGateSession(chatProfile(), canary);
}

function egressProfile(
  id: string,
  enforce: EgressEnforcer,
  extras: { onBlock?: 'refuse_to_user'; canary?: boolean } = {},
) {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id,
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        ...(extras.canary === undefined ? {} : { canary: extras.canary }),
        egress: {
          ...(extras.onBlock ? { onBlock: extras.onBlock } : {}),
          enforce,
        },
      },
    }),
  );
  return getProfile(id);
}

function passEnforce(): Verdict {
  return { action: 'allow' };
}

/** Blocking verdict with an optional user-facing refusal. */
function blockVerdict(rule: string, refusal?: string): Verdict {
  return {
    action: 'block',
    hits: [{ rule, severity: 'high' }],
    rejection: 'blocked',
    ...(refusal ? { refusal } : {}),
  };
}

// ── createLiveOutboundGateSession ─────────────────────────────────────────────

Deno.test('createLiveOutboundGateSession: canary gate is null when no canary supplied', () => {
  const s = session();
  assertEquals(s.gate, null);
  assertEquals(s.context.canary, undefined);
});

Deno.test('createLiveOutboundGateSession: gate is created when canary is supplied', () => {
  const canary = mintCanary();
  const s = session(canary);
  assertEquals(s.context.canary, canary);
  assertEquals(s.gate !== null, true);
});

Deno.test('createLiveOutboundGateSession: withholdVisible starts false', () => {
  assertEquals(session(mintCanary()).withholdVisible, false);
  const profile = egressProfile('live_egress_init', passEnforce);
  assertEquals(createLiveOutboundGateSession(profile).withholdVisible, false);
});

// ── processLiveOutboundBatch — basic streaming ────────────────────────────────

Deno.test('processLiveOutboundBatch emits safe text chunks without a canary gate', async () => {
  const s = session();
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.text, 'hello');
  }
});

Deno.test('processLiveOutboundBatch emits safe long text chunk through the gate', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const longText = 'safe text '.repeat(40); // > DEFAULT_HOLDBACK
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: longText }]);
  assertEquals(result.action === 'emit' || result.action === 'idle', true);
  if (result.action === 'emit') {
    assertEquals((result.events[0]?.text?.length ?? 0) > 0, true);
  }
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a stream event', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: canary }]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
  }
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a non-stream event', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const events: TurnEvent[] = [{ type: 'error', error: canary }];
  const result = await processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch passes non-stream events without canary', async () => {
  const s = session(mintCanary());
  const result = await processLiveOutboundBatch(s, [{ type: 'done' }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events[0]?.type, 'done');
  }
});

Deno.test('processLiveOutboundBatch returns idle for empty event list', async () => {
  const s = session(mintCanary());
  assertEquals((await processLiveOutboundBatch(s, [])).action, 'idle');
});

Deno.test('processLiveOutboundBatch flushes lookback on stream-type transition', async () => {
  const canary = mintCanary();
  const s = session(canary);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = await processLiveOutboundBatch(s, [{ type: 'thought', text: 'thinking' }]);
  assertEquals(result.action !== 'withhold', true);
});

Deno.test('processLiveOutboundBatch withholds when non-stream event follows a pending gate tail with canary', async () => {
  const canary = mintCanary();
  const s = session(canary);
  await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, 5) }]);
  const events: TurnEvent[] = [{ type: 'text', text: canary.slice(5) }, { type: 'done' }];
  const result = await processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

// ── progressive yield under egress.enforce ────────────────────────────────────

Deno.test('processLiveOutboundBatch holds short text in lookback under egress.enforce', async () => {
  let enforced = false;
  const profile = egressProfile('live_egress_hold', () => {
    enforced = true;
    return { action: 'allow' };
  });
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.gate !== null, true);

  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: 'answer' }]);
  assertEquals(result.action, 'idle');
  assertEquals(enforced, true); // progressive scan runs on each chunk
  assertEquals(s.gate?.accumulated(), 'answer');

  const final = await finalizeLiveOutboundTurn(s);
  assertEquals(final.action, 'emit');
  if (final.action === 'emit') {
    assertEquals(
      final.events.some((e) => e.text === 'answer'),
      true,
    );
  }
});

Deno.test('processLiveOutboundBatch streams cleared prefixes under egress.enforce', async () => {
  const profile = egressProfile('live_egress_stream', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  const body = `${'x'.repeat(DEFAULT_HOLDBACK + 40)}tail`;
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: body }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const text = result.events.map((e) => e.text ?? '').join('');
    assertEquals(text.length > 0, true);
    assertEquals(text.endsWith('tail'), false); // lookback still holds the tail
  }
  const final = await finalizeLiveOutboundTurn(s);
  assertEquals(final.action, 'emit');
  if (final.action === 'emit') {
    const flushed = final.events.map((e) => e.text ?? '').join('');
    assertEquals(flushed.includes('tail'), true);
  }
});

// ── speech: spoken-reply transcript and audio ────────────────────────────────

function said(text: string): TurnEvent {
  return {
    type: 'evidence',
    text,
    evidence: { provider: 'google', kind: 'output_transcription' },
  };
}

function audio(n: number): TurnEvent {
  return { type: 'media', media: { mimeType: 'audio/wav', data: `pcm-${n}` } };
}

const turnComplete: TurnEvent = { type: 'session', session: { kind: 'turn_complete' } };

Deno.test('processLiveOutboundBatch holds the spoken-reply transcript in the lookback', async () => {
  const profile = egressProfile('live_egress_asr_hold', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  assertEquals(await processLiveOutboundBatch(s, [said('spoken by model')]), { action: 'idle' });
  assertEquals(s.gate?.accumulated(), 'spoken by model');
  assertEquals(await finalizeLiveOutboundTurn(s), {
    action: 'emit',
    events: [said('spoken by model')],
  });
});

/** A canary-only gate holds one character less than the canary's longest leak form. */
function canaryHold(canary: string): number {
  return canaryLeakSpan(canary) - 1;
}

Deno.test('processLiveOutboundBatch holds audio until the transcript before it clears', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const first = 'a'.repeat(canaryHold(canary));
  // Frame order is transcript then audio: both held under the lookback.
  assertEquals(await processLiveOutboundBatch(s, [said(first), audio(1)]), { action: 'idle' });
  // The next frame's transcript pushes the first past the lookback: it and its audio go.
  const second = 'b'.repeat(canaryHold(canary));
  assertEquals(await processLiveOutboundBatch(s, [said(second), audio(2)]), {
    action: 'emit',
    events: [said(first), audio(1)],
  });
  // The cycle's end releases the rest in arrival order.
  assertEquals(await processLiveOutboundBatch(s, [turnComplete]), {
    action: 'emit',
    events: [said(second), audio(2), turnComplete],
  });
});

Deno.test('processLiveOutboundBatch releases a partial transcript chunk in its own shape', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const body = 'c'.repeat(canaryHold(canary) + 10);
  assertEquals(await processLiveOutboundBatch(s, [said(body), audio(1)]), {
    action: 'emit',
    events: [said('c'.repeat(10))],
  });
  assertEquals(s.held.length, 2);
});

Deno.test('processLiveOutboundBatch withholds a canary spoken across frames with its audio', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = Math.ceil(canary.length / 2);
  assertEquals(
    await processLiveOutboundBatch(s, [said(`Sure. ${canary.slice(0, half)}`), audio(1)]),
    { action: 'idle' },
  );
  const result = await processLiveOutboundBatch(s, [said(canary.slice(half)), audio(2)]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
    assertEquals(
      result.events?.some((e) => e.type === 'media' || e.type === 'evidence'),
      false,
    );
  }
});

Deno.test('processLiveOutboundBatch passes audio straight through without a gate', async () => {
  const s = session();
  assertEquals(await processLiveOutboundBatch(s, [said('hi'), audio(1)]), {
    action: 'emit',
    events: [said('hi'), audio(1)],
  });
});

Deno.test('processLiveOutboundBatch releases audio at once when nothing is held before it', async () => {
  const s = session(mintCanary());
  assertEquals(await processLiveOutboundBatch(s, [audio(1)]), {
    action: 'emit',
    events: [audio(1)],
  });
});

Deno.test('finalizeLiveOutboundTurn releases a withheld cycle when the final verdict allows', async () => {
  let calls = 0;
  const profile = egressProfile('live_egress_allow_after_hit', () => {
    calls += 1;
    return calls === 1 ? blockVerdict('egress.flaky') : { action: 'allow' };
  });
  const s = createLiveOutboundGateSession(profile);
  const mid = await processLiveOutboundBatch(s, [said('hello'), audio(1)]);
  assertEquals(mid.action, 'emit');
  if (mid.action === 'emit') {
    assertEquals(
      mid.events.map((e) => e.type),
      ['guardrail'],
    );
  }
  assertEquals(s.withholdVisible, true);
  assertEquals(await processLiveOutboundBatch(s, [said(' there')]), { action: 'idle' });
  assertEquals(await finalizeLiveOutboundTurn(s), {
    action: 'emit',
    events: [said('hello'), audio(1), said(' there')],
  });
});

Deno.test('finalizeLiveOutboundTurn drops withheld audio when the reply is refused', async () => {
  const profile = egressProfile(
    'live_egress_refuse_audio',
    () => blockVerdict('egress.injection-echo', 'That reply was blocked.'),
    { onBlock: 'refuse_to_user' },
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [said('leaky'), audio(1)]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(
      result.events.map((e) => e.type),
      ['guardrail', 'text'],
    );
    assertEquals(result.events.at(-1)?.text, 'That reply was blocked.');
  }
});

Deno.test('finalizeLiveOutboundTurn starts the next cycle clean', async () => {
  const profile = egressProfile(
    'live_egress_next_cycle',
    (payload) =>
      typeof payload.text === 'string' && payload.text.includes('bad')
        ? blockVerdict('egress.bad', 'Blocked.')
        : { action: 'allow' },
    { onBlock: 'refuse_to_user' },
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [said('bad')]);
  assertEquals(s.withholdVisible, true);
  await finalizeLiveOutboundTurn(s);
  assertEquals(s.withholdVisible, false);
  assertEquals(s.gate?.accumulated(), '');
  assertEquals(s.held, []);
  // The next cycle is judged on its own reply and is heard.
  assertEquals(await processLiveOutboundBatch(s, [said('good'), audio(2)]), { action: 'idle' });
  assertEquals(await finalizeLiveOutboundTurn(s), {
    action: 'emit',
    events: [said('good'), audio(2)],
  });
});

Deno.test('abortLiveOutboundTurn drops held audio', async () => {
  const s = session(mintCanary());
  await processLiveOutboundBatch(s, [said('interrupted'), audio(1)]);
  assertEquals(s.held.length, 2);
  abortLiveOutboundTurn(s);
  assertEquals(s.held, []);
  assertEquals(await finalizeLiveOutboundTurn(s), { action: 'idle' });
});

Deno.test('finalizeLiveOutboundTurn withholds when egress.enforce blocks', async () => {
  const profile = egressProfile('live_egress_block', () => blockVerdict('egress.injection-echo'));
  const s = createLiveOutboundGateSession(profile, mintCanary());
  const mid = await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(mid.action, 'emit');
  if (mid.action === 'emit') {
    assertEquals(mid.events[0]?.type, 'guardrail');
    assertEquals(mid.events[0]?.guardrail?.stage, 'live_outbound');
  }
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error, PUBLIC_CANARY);
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user text when onBlock is set', async () => {
  const profile = egressProfile(
    'live_egress_refuse',
    () => blockVerdict('egress.canary-leak', 'That reply was blocked.'),
    { onBlock: 'refuse_to_user' },
  );
  const s = createLiveOutboundGateSession(profile, mintCanary());
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const refusal = result.events.find((e) => e.type === 'text');
    assertEquals(refusal?.text, 'That reply was blocked.');
    assertEquals(
      result.events.some((e) => e.type === 'guardrail'),
      true,
    );
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user for non-canary egress hits', async () => {
  const profile = egressProfile(
    'live_egress_refuse_inj',
    () => blockVerdict('egress.injection-echo', 'That reply was blocked.'),
    { onBlock: 'refuse_to_user' },
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const refusal = result.events.find((e) => e.type === 'text');
    assertEquals(refusal?.text, 'That reply was blocked.');
  }
});

// ── finalizeLiveOutboundTurn — canary-only ────────────────────────────────────

Deno.test('finalizeLiveOutboundTurn flushes progressive gate tail on finalize', async () => {
  const canary = mintCanary();
  const s = session(canary);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'prefix ' }]);
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

Deno.test('processLiveOutboundBatch withholds when progressive canary leak completes', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = Math.ceil(canary.length / 2);
  await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, half) }]);
  const result2 = await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(result2.action, 'withhold');
});

// ── abortLiveOutboundTurn ────────────────────────────────────────────────────

Deno.test('abortLiveOutboundTurn clears progressive state and resets the gate', async () => {
  const canary = mintCanary();
  const s = session(canary);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'partial answer' }]);
  s.withholdVisible = true;
  abortLiveOutboundTurn(s);
  assertEquals(s.withholdVisible, false);
  assertEquals(s.held, []);
  assertEquals(s.releasedTo, 0);
  assertEquals(s.gate !== null, true);
  assertEquals(s.gate?.accumulated(), '');
});

Deno.test('abortLiveOutboundTurn without canary does not recreate gate', () => {
  const s = session();
  abortLiveOutboundTurn(s);
  assertEquals(s.gate, null);
});

Deno.test('processLiveOutboundBatch returns idle when all text is held in lookback', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: 'hi' }]);
  assertEquals(result.action, 'idle');
});

Deno.test('processLiveOutboundBatch passes thoughts unscanned under egress', async () => {
  const profile = egressProfile('live_egress_thought', () => blockVerdict('any.text'));
  const s = createLiveOutboundGateSession(profile);
  const thought: TurnEvent = { type: 'thought', text: 'inner reasoning' };
  const result = await processLiveOutboundBatch(s, [thought]);
  assertEquals(result, { action: 'emit', events: [thought] });
  assertEquals(s.gate?.accumulated(), '');
  assertEquals(await finalizeLiveOutboundTurn(s), { action: 'idle' });
});

Deno.test('processLiveOutboundBatch passes a thought that restates the canary', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const thought: TurnEvent = { type: 'thought', text: `The canary is ${canary}.` };
  assertEquals(await processLiveOutboundBatch(s, [thought]), { action: 'emit', events: [thought] });
});

Deno.test('createLiveOutboundGateSession with canary=false profile ignores provided canary', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_canary_disabled',
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, canary: false },
    }),
  );
  const profile = getProfile('live_canary_disabled');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  assertEquals(s.gate, null);
  assertEquals(s.context.canary, undefined);
});

Deno.test('createLiveOutboundGateSession with canary=true profile but no canary string leaves gate null', () => {
  const s = session();
  assertEquals(s.gate, null);
  assertEquals(s.context.canary, undefined);
});

Deno.test('finalizeLiveOutboundTurn is idle when gate is null', async () => {
  const s = session();
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('processLiveOutboundBatch does not accumulate non-text events under egress', async () => {
  const profile = egressProfile('live_type_filter', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'done' }]);
  assertEquals(s.gate?.accumulated() ?? '', '');
});

Deno.test('finalizeLiveOutboundTurn emits lookback text when enforce passes', async () => {
  const profile = egressProfile('live_hold_no_egress', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'response content' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(
      result.events.some((e) => e.text === 'response content'),
      true,
    );
  }
});

Deno.test('finalizeLiveOutboundTurn emits redact text in place of the model output', async () => {
  const profile = egressProfile(
    'live_egress_redact',
    (): Verdict => ({
      action: 'redact',
      text: 'Rewritten for release.',
      hits: [{ rule: 'egress.injection-echo', severity: 'medium' }],
    }),
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'raw model prose' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const rewritten = result.events.find((e) => e.type === 'text');
    assertEquals(rewritten?.text, 'Rewritten for release.');
  }
});

Deno.test('finalizeLiveOutboundTurn onBlock defaults to withhold for non-canary hits', async () => {
  // No `refusal` on the verdict: onBlock has nothing to show, so the turn is withheld.
  const profile = egressProfile('live_refuse_both_parts', () =>
    blockVerdict('egress.injection-echo'),
  );
  const s = createLiveOutboundGateSession(profile, mintCanary());
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'partial' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch emits non-visible event types immediately under egress', async () => {
  const profile = egressProfile('live_egress_nonvis', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  const result = await processLiveOutboundBatch(s, [
    { type: 'tokens', tokens: { input: 1, output: 1, total: 2 } },
    { type: 'done' },
  ]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events.length, 2);
  }
});

Deno.test('processLiveOutboundBatch ignores empty text fragments', async () => {
  const profile = egressProfile('live_no_text_field', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text' }]);
  assertEquals(s.gate?.accumulated() ?? '', '');
});

Deno.test('processLiveOutboundBatch with canary+egress streams cleared prefixes', async () => {
  const profile = egressProfile('live_gate_hold', passEnforce, { canary: true });
  const canary = mintCanary();
  const s = createLiveOutboundGateSession(profile, canary);
  assertEquals(s.gate !== null, true);
  const body = 'a'.repeat(DEFAULT_HOLDBACK + 80);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: body }]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals((result.events[0]?.text?.length ?? 0) > 0, true);
  }
});

Deno.test('processLiveOutboundBatch with canary-only emits cleared prefixes', async () => {
  const canary = mintCanary();
  const s = session(canary);
  assertEquals(s.withholdVisible, false);
  const result = await processLiveOutboundBatch(s, [
    { type: 'text', text: 'a'.repeat(DEFAULT_HOLDBACK + 80) },
  ]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events.length > 0, true);
    const text = result.events.map((e) => e.text ?? '').join('');
    assertEquals(text.length > 0, true);
  }
});

Deno.test('finalizeLiveOutboundTurn is idle when gate pending is empty after empty-text event', async () => {
  const canary = mintCanary();
  const s = session(canary);
  await processLiveOutboundBatch(s, [{ type: 'text', text: '' }]);
  assertEquals(s.held, []);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('finalizeLiveOutboundTurn is idle when egress gate has nothing buffered', async () => {
  const profile = getProfile('live_egress_hold');
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.withholdVisible, false);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('finalizeLiveOutboundTurn passes accumulated text to egress enforce ctx', async () => {
  const profile = egressProfile('live_egress_ctx_verify', (payload, context) => {
    if (typeof payload.text !== 'string') throw new Error('payload.text missing');
    if (context.stage !== 'live_outbound') throw new Error('unexpected stage');
    return { action: 'allow' };
  });
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'response content' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
});

Deno.test('processLiveOutboundBatch withholds split canary across batches', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = Math.ceil(canary.length / 2);
  await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, half) }]);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch releases held text before a following thought', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const text = 'a'.repeat(canaryHold(canary));
  const thought: TurnEvent = { type: 'thought', text: 'b'.repeat(100) };
  // Under the lookback: all of it is held.
  assertEquals(await processLiveOutboundBatch(s, [{ type: 'text', text }]), { action: 'idle' });
  assertEquals(await processLiveOutboundBatch(s, [thought]), {
    action: 'emit',
    events: [{ type: 'text', text }, thought],
  });
});

Deno.test('processLiveOutboundBatch under egress holds the profile holdback', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_egress_short_hold',
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, egress: { enforce: passEnforce, holdback: 20 } },
    }),
  );
  const s = createLiveOutboundGateSession(getProfile('live_egress_short_hold'));
  assertEquals(await processLiveOutboundBatch(s, [said('x'.repeat(30)), audio(1)]), {
    action: 'emit',
    events: [said('x'.repeat(10))],
  });
});
