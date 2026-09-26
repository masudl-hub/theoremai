import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { FIXED_CANARY } from '../../src/guardrails/corpus/canary-egress-attacks.ts';
import { type LexiconOverrides, lexiconDefault } from '../../src/guardrails/lexicon.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { DEFAULT_HOLDBACK, LIVE_DEFAULT_HOLDBACK } from '../../src/guardrails/progressive-yield.ts';
import type { EgressEnforcer, Verdict } from '../../src/guardrails/types.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { CANARY_OPENING } from '../fixtures/canary.ts';
import { firstOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Opening of the fixed canary: text ending in it could still become a leak, so it is held. */
const LEAD = FIXED_CANARY.slice(0, 6);

function chatProfile() {
  return getProfile('chat');
}

function session(canary?: string) {
  return createLiveOutboundGateSession(chatProfile(), canary);
}

function egressProfile(
  id: string,
  enforce: EgressEnforcer,
  extras: {
    onBlock?: 'refuse_to_user';
    canary?: boolean;
    lexicon?: LexiconOverrides;
    holdback?: number;
  } = {},
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
          ...(extras.holdback === undefined ? {} : { holdback: extras.holdback }),
          enforce,
        },
      },
      ...(extras.lexicon ? { lexicon: extras.lexicon } : {}),
    }),
  );
  return getProfile(id);
}

function passEnforce(): Verdict {
  return { action: 'allow' };
}

/** Blocking verdict for one rule. */
function blockVerdict(rule: string): Verdict {
  return { action: 'block', hits: [{ rule, severity: 'high' }], rejection: 'blocked' };
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
    assertEquals(replyText(result.events), 'hello');
  }
});

Deno.test('processLiveOutboundBatch emits safe long text chunk through the gate', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const longText = 'safe text '.repeat(40); // > DEFAULT_HOLDBACK
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: longText }]);
  assertEquals(result.action === 'emit' || result.action === 'idle', true);
  if (result.action === 'emit') {
    assertEquals(replyText(result.events).length > 0, true);
  }
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a stream event', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: canary }]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error.kind, 'safety');
  }
});

Deno.test('processLiveOutboundBatch withholds when canary appears in a non-stream event', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const events: TurnEvent[] = [{ type: 'error', errorKind: 'internal', error: canary }];
  const result = await processLiveOutboundBatch(s, events);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch passes non-stream events without canary', async () => {
  const s = session(mintCanary());
  const result = await processLiveOutboundBatch(s, [{ type: 'done', stop: { kind: 'completed' } }]);
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
  const events: TurnEvent[] = [
    { type: 'text', text: canary.slice(5) },
    { type: 'done', stop: { kind: 'completed' } },
  ];
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
      final.events.some((e) => e.type === 'text' && e.text === 'answer'),
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
    const text = replyText(result.events);
    assertEquals(text.length > 0, true);
    assertEquals(text.endsWith('tail'), false); // lookback still holds the tail
  }
  const final = await finalizeLiveOutboundTurn(s);
  assertEquals(final.action, 'emit');
  if (final.action === 'emit') {
    const flushed = replyText(final.events);
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

Deno.test('processLiveOutboundBatch streams audio with its own message transcript', async () => {
  const s = session(FIXED_CANARY);
  // One batch is one provider message: its transcript covers its audio, so both go together.
  assertEquals(await processLiveOutboundBatch(s, [said('Hello there.'), audio(1)]), {
    action: 'emit',
    events: [said('Hello there.'), audio(1)],
  });
  assertEquals(
    await processLiveOutboundBatch(s, [said(' Nothing to see here, really.'), audio(2)]),
    { action: 'emit', events: [said(' Nothing to see here, really.'), audio(2)] },
  );
  // A non-reply event goes at once.
  assertEquals(await processLiveOutboundBatch(s, [turnComplete]), {
    action: 'emit',
    events: [turnComplete],
  });
  assertEquals(await finalizeLiveOutboundTurn(s), { action: 'idle' });
});

Deno.test('processLiveOutboundBatch holds audio without a transcript until the next one clears it', async () => {
  const s = session(FIXED_CANARY);
  assertEquals(await processLiveOutboundBatch(s, [said('Hello there.'), audio(1)]), {
    action: 'emit',
    events: [said('Hello there.'), audio(1)],
  });
  // A message of audio alone has no words to read yet: it waits.
  assertEquals(await processLiveOutboundBatch(s, [audio(2)]), { action: 'idle' });
  // The next transcript covers it and is clean: the held audio goes first.
  assertEquals(await processLiveOutboundBatch(s, [said(' Bye now.'), audio(3)]), {
    action: 'emit',
    events: [audio(2), said(' Bye now.'), audio(3)],
  });
});

Deno.test('processLiveOutboundBatch keeps audio held while its cover could open a leak', async () => {
  const s = session(FIXED_CANARY);
  assertEquals(await processLiveOutboundBatch(s, [said('Hello there.'), audio(1)]), {
    action: 'emit',
    events: [said('Hello there.'), audio(1)],
  });
  // Its own transcript ends in a possible canary opening: the audio stays with it.
  assertEquals(await processLiveOutboundBatch(s, [said(` ${LEAD}`), audio(2)]), {
    action: 'emit',
    events: [said(' ')],
  });
  assertEquals(
    s.held.map((item) => item.event.type),
    ['evidence', 'media'],
  );
});

Deno.test('processLiveOutboundBatch releases the last audio at generation_complete', async () => {
  const s = session(FIXED_CANARY);
  const generated: TurnEvent = { type: 'done', stop: { kind: 'generation_complete' } };
  assertEquals(await processLiveOutboundBatch(s, [said('All done.'), audio(1)]), {
    action: 'emit',
    events: [said('All done.'), audio(1)],
  });
  assertEquals(await processLiveOutboundBatch(s, [audio(2)]), { action: 'idle' });
  // The model finished: its transcript is whole, so the audio after it needs no later cover.
  assertEquals(await processLiveOutboundBatch(s, [generated]), {
    action: 'emit',
    events: [audio(2), generated],
  });
  assertEquals(s.held, []);
  assertEquals(await finalizeLiveOutboundTurn(s), { action: 'idle' });
});

Deno.test('processLiveOutboundBatch keeps untranscribed audio past generation_complete', async () => {
  const s = session(FIXED_CANARY);
  const generated: TurnEvent = { type: 'done', stop: { kind: 'generation_complete' } };
  assertEquals(await processLiveOutboundBatch(s, [audio(1), generated]), {
    action: 'emit',
    events: [generated],
  });
  const end = await finalizeLiveOutboundTurn(s);
  assertEquals(end.action === 'emit' && end.events.map((e) => e.type), ['guardrail']);
});

Deno.test('processLiveOutboundBatch covers audio listed before its transcript in one message', async () => {
  const s = session(FIXED_CANARY);
  // The transcript read later in the same message still covers the audio: both go, in order.
  assertEquals(await processLiveOutboundBatch(s, [audio(1), said('spoken by model')]), {
    action: 'emit',
    events: [audio(1), said('spoken by model')],
  });
  assertEquals(await finalizeLiveOutboundTurn(s), { action: 'idle' });
});

Deno.test('processLiveOutboundBatch withholds audio that arrives before its leaking transcript', async () => {
  const canary = mintCanary();
  const s = session(canary);
  // Native audio leads its transcript: the audio must not go before the transcript is read.
  assertEquals(await processLiveOutboundBatch(s, [audio(1), audio(2)]), { action: 'idle' });
  const result = await processLiveOutboundBatch(s, [said(`Sure, ${canary}`)]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(
      result.events?.some((e) => e.type === 'media'),
      false,
    );
  }
});

Deno.test('finalizeLiveOutboundTurn drops audio from a cycle with no transcript', async () => {
  const s = session(mintCanary());
  assertEquals(await processLiveOutboundBatch(s, [audio(1)]), { action: 'idle' });
  const end = await finalizeLiveOutboundTurn(s);
  assertEquals(end.action, 'emit');
  if (end.action === 'emit') {
    assertEquals(
      end.events.map((e) => e.type),
      ['guardrail'],
    );
    assertEquals(
      firstOf(end.events, 'guardrail')?.guardrail.hits[0]?.rule,
      'live.untranscribed-audio',
    );
  }
});

Deno.test('processLiveOutboundBatch releases a partial transcript chunk in its own shape', async () => {
  const s = session(FIXED_CANARY);
  assertEquals(await processLiveOutboundBatch(s, [said(`hello ${LEAD}`), audio(1)]), {
    action: 'emit',
    events: [said('hello ')],
  });
  assertEquals(s.held.length, 2);
});

Deno.test('processLiveOutboundBatch withholds a canary spoken with separators across frames', async () => {
  const s = session(FIXED_CANARY);
  const spoken = [...FIXED_CANARY.toUpperCase()].join(', ');
  const half = CANARY_OPENING * ', X'.length;
  await processLiveOutboundBatch(s, [said(spoken.slice(0, half)), audio(1)]);
  const result = await processLiveOutboundBatch(s, [said(spoken.slice(half)), audio(2)]);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch withholds a canary spoken across frames with its audio', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = CANARY_OPENING;
  // Only what could start the leak is held, with the audio behind it.
  assertEquals(
    await processLiveOutboundBatch(s, [said(`Sure. ${canary.slice(0, half)}`), audio(1)]),
    { action: 'emit', events: [said('Sure. ')] },
  );
  const result = await processLiveOutboundBatch(s, [said(canary.slice(half)), audio(2)]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error.kind, 'safety');
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
    () => blockVerdict('egress.injection-echo'),
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
    assertEquals(result.events.at(-1), { type: 'text', text: lexiconDefault('egress.refusal') });
  }
});

Deno.test('finalizeLiveOutboundTurn starts the next cycle clean', async () => {
  const profile = egressProfile(
    'live_egress_next_cycle',
    (payload) =>
      typeof payload.text === 'string' && payload.text.includes('bad')
        ? blockVerdict('egress.bad')
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
  const s = session(FIXED_CANARY);
  await processLiveOutboundBatch(s, [said(LEAD), audio(1)]);
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
    assertEquals(firstOf(mid.events, 'guardrail')?.guardrail.stage, 'live_outbound');
  }
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error.kind, 'safety');
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user text when onBlock is set', async () => {
  const profile = egressProfile('live_egress_refuse', () => blockVerdict('egress.canary-leak'), {
    onBlock: 'refuse_to_user',
  });
  const s = createLiveOutboundGateSession(profile, mintCanary());
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const refusal = firstOf(result.events, 'text');
    assertEquals(refusal?.text, lexiconDefault('egress.refusal'));
    assertEquals(
      result.events.some((e) => e.type === 'guardrail'),
      true,
    );
  }
});

Deno.test('finalizeLiveOutboundTurn refuses in the profile lexicon wording', async () => {
  const profile = egressProfile('live_egress_refuse_lexicon', () => blockVerdict('egress.bad'), {
    onBlock: 'refuse_to_user',
    lexicon: { 'egress.refusal': 'Host refusal.' },
  });
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(firstOf(result.events, 'text')?.text, 'Host refusal.');
  }
});

Deno.test('finalizeLiveOutboundTurn emits refuse_to_user for non-canary egress hits', async () => {
  const profile = egressProfile(
    'live_egress_refuse_inj',
    () => blockVerdict('egress.injection-echo'),
    { onBlock: 'refuse_to_user' },
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'hello' }]);
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const refusal = firstOf(result.events, 'text');
    assertEquals(refusal?.text, lexiconDefault('egress.refusal'));
  }
});

// ── finalizeLiveOutboundTurn — canary-only ────────────────────────────────────

Deno.test('finalizeLiveOutboundTurn flushes progressive gate tail on finalize', async () => {
  const s = session(FIXED_CANARY);
  await processLiveOutboundBatch(s, [{ type: 'text', text: `prefix ${LEAD}` }]);
  assertEquals(await finalizeLiveOutboundTurn(s), {
    action: 'emit',
    events: [{ type: 'text', text: LEAD }],
  });
});

Deno.test('finalizeLiveOutboundTurn returns idle when there is nothing to emit', async () => {
  const s = session(mintCanary());
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('processLiveOutboundBatch withholds when progressive canary leak completes', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = CANARY_OPENING;
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

Deno.test('processLiveOutboundBatch returns idle when all text could start a leak', async () => {
  const s = session(FIXED_CANARY);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: LEAD }]);
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
  await processLiveOutboundBatch(s, [{ type: 'done', stop: { kind: 'completed' } }]);
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
      result.events.some((e) => e.type === 'text' && e.text === 'response content'),
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
    const rewritten = firstOf(result.events, 'text');
    assertEquals(rewritten?.text, 'Rewritten for release.');
  }
});

Deno.test('finalizeLiveOutboundTurn onBlock defaults to withhold for non-canary hits', async () => {
  // onBlock defaults to reject_to_agent; with no retries left the turn is withheld.
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
    { type: 'done', stop: { kind: 'completed' } },
  ]);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    assertEquals(result.events.length, 2);
  }
});

Deno.test('processLiveOutboundBatch ignores empty text fragments', async () => {
  const profile = egressProfile('live_no_text_field', passEnforce);
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: '' }]);
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
    assertEquals(replyText(result.events).length > 0, true);
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
    const text = replyText(result.events);
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
  const half = CANARY_OPENING;
  await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(0, half) }]);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: canary.slice(half) }]);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch releases held text before a following thought', async () => {
  const s = session(FIXED_CANARY);
  const text = LEAD;
  const thought: TurnEvent = { type: 'thought', text: 'b'.repeat(100) };
  // It could start a leak: all of it is held.
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

Deno.test('processLiveOutboundBatch catches a canary split across cycles', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = CANARY_OPENING;
  await processLiveOutboundBatch(s, [said(`Part one: ${canary.slice(0, half)}`)]);
  assertEquals((await finalizeLiveOutboundTurn(s)).action, 'emit');
  // The session canary is stable: the next cycle reads the last one's opening first.
  const next = await processLiveOutboundBatch(s, [said(canary.slice(half))]);
  assertEquals(next.action, 'withhold');
});

Deno.test('createLiveOutboundGateSession holds LIVE_DEFAULT_HOLDBACK under egress', async () => {
  const s = createLiveOutboundGateSession(egressProfile('live_holdback_default', passEnforce));
  await processLiveOutboundBatch(s, [said('s'.repeat(LIVE_DEFAULT_HOLDBACK * 3))]);
  assertEquals(s.gate?.unreleased().length, LIVE_DEFAULT_HOLDBACK);
});

Deno.test('createLiveOutboundGateSession keeps a holdback the host set', async () => {
  const s = createLiveOutboundGateSession(
    egressProfile('live_holdback_host', passEnforce, { holdback: DEFAULT_HOLDBACK }),
  );
  await processLiveOutboundBatch(s, [said('s'.repeat(DEFAULT_HOLDBACK * 2))]);
  assertEquals(s.gate?.unreleased().length, DEFAULT_HOLDBACK);
});
