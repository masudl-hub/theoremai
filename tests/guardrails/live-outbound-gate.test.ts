import '../fixtures/test-host.ts';
import { canaryHoldFrom, mintCanary } from '../../src/guardrails/canary.ts';
import { FIXED_CANARY } from '../../src/guardrails/corpus/canary-egress-attacks.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { DETECTORS, HOST_FIND_HOLD_LIVE, type HostFind } from '../../src/guardrails/detectors.ts';
import { givenUrlSets } from '../../src/guardrails/egress-urls.ts';
import { type LexiconOverrides, lexiconDefault } from '../../src/guardrails/lexicon.ts';
import {
  abortLiveOutboundTurn,
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { CANARY_OPENING } from '../fixtures/canary.ts';
import { eventsOf, firstOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

/** Opening of the fixed canary: text ending in it could still become a leak, so it is held. */
const LEAD = FIXED_CANARY.slice(0, 6);

function chatProfile() {
  return getProfile('chat');
}

function session(canary?: string) {
  return createLiveOutboundGateSession(chatProfile(), canary);
}

/** A session of a profile no detector reads: nothing gates its reply. */
function unreadSession(canary?: string) {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_unread',
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, detect: 'ignore' },
    }),
  );
  return createLiveOutboundGateSession(getProfile('live_unread'), canary);
}

/** A profile with one detector of the host's own, which blocks a Live reply where `find` matches. */
function hostProfile(
  id: string,
  find: HostFind,
  extras: {
    onBlock?: 'refuse';
    leaks?: 'ignore';
    lexicon?: LexiconOverrides;
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
        detect: {
          ...(extras.leaks === 'ignore'
            ? ({ canary_leak: 'ignore', prompt_leak: 'ignore' } as const)
            : {}),
          'test.own': { label: 'Test', at: { live_reply: 'block' }, find },
        },
        ...(extras.onBlock ? { blockedReply: { onBlock: extras.onBlock } } : {}),
      },
      ...(extras.lexicon ? { lexicon: extras.lexicon } : {}),
    }),
  );
  return getProfile(id);
}

/**
 * A leak found mid-cycle shows nothing more of the cycle, and the cycle's end
 * withholds it: what the batch let out, checked for `leak`, then the verdict.
 */
async function withheldAtEnd(
  s: ReturnType<typeof session>,
  batch: Awaited<ReturnType<typeof processLiveOutboundBatch>>,
  leak: string,
) {
  assertEquals(batch.action === 'withhold', false);
  const shown = batch.action === 'emit' ? batch.events : [];
  assertEquals(JSON.stringify(shown).includes(leak), false);
  assertEquals(
    shown.some((e) => e.type === 'media'),
    false,
  );
  const end = await finalizeLiveOutboundTurn(s);
  assertEquals(end.action, 'withhold');
  if (end.action !== 'withhold') throw new Error('not withheld');
  assertEquals(end.error.kind, 'safety');
  assertEquals(
    end.events?.some((e) => e.type === 'media' || e.type === 'evidence' || e.type === 'text'),
    false,
  );
  return end;
}

/** A `find` that matches nothing. */
const findNothing: HostFind = () => [];

/** A `find` that matches all of any text. */
const findAll: HostFind = (text) => (text ? [{ start: 0, end: text.length }] : []);

/** Longer than a Live reply holds for a `find`, so some of it comes up for release as it streams. */
const LONG = 'hello '.repeat(40);

/** A `find` that matches all of a text `matches` is true of. */
function findWhere(matches: (text: string) => boolean): HostFind {
  return (text) => (matches(text) ? findAll(text, { boundary: 'live_reply' }) : []);
}

Deno.test('createLiveOutboundGateSession: with no canary the default detectors still gate the reply', () => {
  const s = session();
  assertEquals(s.gate !== null, true);
  assertEquals(s.context.canary, undefined);
  assertEquals(unreadSession().gate, null);
});

Deno.test('createLiveOutboundGateSession: gate is created when canary is supplied', () => {
  const canary = mintCanary();
  const s = session(canary);
  assertEquals(s.context.canary, canary);
  assertEquals(s.gate !== null, true);
});

Deno.test('createLiveOutboundGateSession: withholdVisible starts false', () => {
  assertEquals(session(mintCanary()).withholdVisible, false);
  const profile = hostProfile('live_egress_init', findNothing);
  assertEquals(createLiveOutboundGateSession(profile).withholdVisible, false);
});

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
  const longText = 'safe text '.repeat(40);
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
  await withheldAtEnd(s, result, canary);
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
  await withheldAtEnd(s, result, canary.slice(5));
});

Deno.test("processLiveOutboundBatch holds short text for a find of the host's", async () => {
  let enforced = false;
  const profile = hostProfile('live_egress_hold', () => {
    enforced = true;
    return [];
  });
  const s = createLiveOutboundGateSession(profile);
  assertEquals(s.gate !== null, true);

  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: 'answer' }]);
  assertEquals(result.action, 'idle');
  assertEquals(enforced, true); // the find reads each chunk as it comes
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

Deno.test("processLiveOutboundBatch streams what a find of the host's has cleared", async () => {
  const profile = hostProfile('live_egress_stream', findNothing);
  const s = createLiveOutboundGateSession(profile);
  const body = `${'x'.repeat(HOST_FIND_HOLD_LIVE + 40)}tail`;
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
  const profile = hostProfile('live_egress_asr_hold', findNothing);
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
  await withheldAtEnd(s, result, canary);
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
  await withheldAtEnd(s, result, spoken.slice(half));
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
  await withheldAtEnd(s, result, canary.slice(half));
});

Deno.test('processLiveOutboundBatch passes audio straight through without a gate', async () => {
  const s = session();
  assertEquals(await processLiveOutboundBatch(s, [said('hi'), audio(1)]), {
    action: 'emit',
    events: [said('hi'), audio(1)],
  });
});

Deno.test('finalizeLiveOutboundTurn releases a withheld cycle when the final verdict allows', async () => {
  // What the reply went on to say is not a match: the whole reply is what the verdict reads.
  const profile = hostProfile(
    'live_egress_allow_after_hit',
    findWhere((text) => !text.includes('there')),
  );
  const s = createLiveOutboundGateSession(profile);
  assertEquals(await processLiveOutboundBatch(s, [said(LONG), audio(1)]), { action: 'idle' });
  assertEquals(s.withholdVisible, true);
  assertEquals(await processLiveOutboundBatch(s, [said(' there')]), { action: 'idle' });
  assertEquals(await finalizeLiveOutboundTurn(s), {
    action: 'emit',
    events: [said(LONG), audio(1), said(' there')],
  });
});

Deno.test('finalizeLiveOutboundTurn drops withheld audio when the reply is refused', async () => {
  const profile = hostProfile('live_egress_refuse_audio', findAll, {
    onBlock: 'refuse',
  });
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
  const profile = hostProfile(
    'live_egress_next_cycle',
    findWhere((text) => text.includes('bad')),
    { onBlock: 'refuse' },
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [said('bad '.repeat(40))]);
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

Deno.test("finalizeLiveOutboundTurn withholds when a detector of the host's blocks", async () => {
  const profile = hostProfile('live_egress_block', findAll);
  const s = createLiveOutboundGateSession(profile, mintCanary());
  // The match shows nothing more of the cycle; its end is what reports it.
  assertEquals(await processLiveOutboundBatch(s, [{ type: 'text', text: LONG }]), {
    action: 'idle',
  });
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error.kind, 'safety');
    const reported = eventsOf(result.events ?? [], 'guardrail').map(({ guardrail }) => [
      guardrail.stage,
      guardrail.boundary,
      guardrail.hits.map((hit) => hit.rule),
    ]);
    assertEquals(reported, [['live_outbound', 'live_reply', ['detect.test.own']]]);
  }
});

Deno.test('finalizeLiveOutboundTurn emits the refusal when blockedReply.onBlock is refuse', async () => {
  const profile = hostProfile('live_egress_refuse', findAll, {
    onBlock: 'refuse',
  });
  const s = createLiveOutboundGateSession(profile, mintCanary());
  await processLiveOutboundBatch(s, [{ type: 'text', text: LONG }]);
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
  const profile = hostProfile('live_egress_refuse_lexicon', findAll, {
    onBlock: 'refuse',
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

Deno.test('finalizeLiveOutboundTurn emits the refusal for non-canary egress hits', async () => {
  const profile = hostProfile('live_egress_refuse_inj', findAll, {
    onBlock: 'refuse',
  });
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: LONG }]);
  assertEquals(s.withholdVisible, true);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'emit');
  if (result.action === 'emit') {
    const refusal = firstOf(result.events, 'text');
    assertEquals(refusal?.text, lexiconDefault('egress.refusal'));
  }
});

Deno.test('finalizeLiveOutboundTurn flushes progressive gate tail on finalize', async () => {
  const s = session(FIXED_CANARY);
  await processLiveOutboundBatch(s, [{ type: 'text', text: `hi ${LEAD}` }]);
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
  await withheldAtEnd(s, result2, canary.slice(half));
});

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

Deno.test('abortLiveOutboundTurn on an ungated session does not create a gate', () => {
  const s = unreadSession();
  abortLiveOutboundTurn(s);
  assertEquals(s.gate, null);
});

Deno.test('processLiveOutboundBatch returns idle when all text could start a leak', async () => {
  const s = session(FIXED_CANARY);
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: LEAD }]);
  assertEquals(result.action, 'idle');
});

Deno.test('processLiveOutboundBatch passes thoughts unscanned under egress', async () => {
  const profile = hostProfile('live_egress_thought', findAll);
  const s = createLiveOutboundGateSession(profile);
  const thought: TurnEvent = { type: 'thought', text: 'inner reasoning' };
  const result = await processLiveOutboundBatch(s, [thought]);
  assertEquals(result, { action: 'emit', events: [thought] });
  assertEquals(s.gate?.accumulated(), '');
  assertEquals(await finalizeLiveOutboundTurn(s), { action: 'idle' });
});

/** A thought naming `canary`, and the redaction the batch reports on it. */
async function thoughtNaming(canary: string) {
  const s = session(canary);
  const text = `The canary is ${canary}.`;
  const result = await processLiveOutboundBatch(s, [{ type: 'thought', text }]);
  assertEquals(result.action, 'emit');
  const [guardrail, ...shown] = result.action === 'emit' ? (result.events ?? []) : [];
  assertEquals(guardrail?.type === 'guardrail' && guardrail.guardrail.stage, 'thought');
  assertEquals(guardrail?.type === 'guardrail' && guardrail.guardrail.action, 'redact');
  return { s, text, shown };
}

const OMITTED = lexiconDefault('thought.omitted_instructions');

Deno.test('processLiveOutboundBatch omits the canary from a thought and reports it', async () => {
  const canary = '552434a3798aeb8518b8ab775dea9a4e';
  const { text, shown } = await thoughtNaming(canary);
  assertEquals(canaryHoldFrom(text, canary), text.length);
  assertEquals(shown, [{ type: 'thought', text: `The canary is${OMITTED}.` }]);
});

Deno.test('a thought holds the omission of a canary that could open another until the turn ends', async () => {
  const canary = '936e028e499b23968af25360621796cc';
  const { s, text, shown } = await thoughtNaming(canary);
  // Its own tail could start another copy, which the next chunk could finish.
  assertEquals(canaryHoldFrom(text, canary) < text.length, true);
  assertEquals(shown, [{ type: 'thought', text: 'The canary is ' }]);
  assertEquals(await finalizeLiveOutboundTurn(s), {
    action: 'emit',
    events: [{ type: 'thought', text: `${OMITTED.trimStart()}.` }],
  });
});

Deno.test('createLiveOutboundGateSession with a profile that reads for no leak ignores a provided canary', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_canary_disabled',
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        detect: { canary_leak: 'ignore', prompt_leak: 'ignore' },
      },
    }),
  );
  const profile = getProfile('live_canary_disabled');
  const s = createLiveOutboundGateSession(profile, mintCanary());
  // The detectors left at their defaults still gate the reply; none of them is given the canary.
  assertEquals(s.gate !== null, true);
  assertEquals(s.context.canary, undefined);
});

Deno.test('createLiveOutboundGateSession with no detector reading leaves gate null, canary or not', () => {
  for (const s of [unreadSession(), unreadSession(mintCanary())]) {
    assertEquals(s.gate, null);
    assertEquals(s.context.canary, undefined);
  }
});

Deno.test('finalizeLiveOutboundTurn is idle when gate is null', async () => {
  const s = unreadSession();
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'idle');
});

Deno.test('processLiveOutboundBatch does not accumulate non-text events under egress', async () => {
  const profile = hostProfile('live_type_filter', findNothing);
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'done', stop: { kind: 'completed' } }]);
  assertEquals(s.gate?.accumulated() ?? '', '');
});

Deno.test('finalizeLiveOutboundTurn emits the held text when nothing matched', async () => {
  const profile = hostProfile('live_hold_no_egress', findNothing);
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

Deno.test('finalizeLiveOutboundTurn withholds on a non-canary hit when blockedReply is left out', async () => {
  // blockedReply.onBlock defaults to retry, and Live never retries: the turn is withheld.
  const profile = hostProfile('live_refuse_both_parts', findAll);
  const s = createLiveOutboundGateSession(profile, mintCanary());
  await processLiveOutboundBatch(s, [{ type: 'text', text: 'partial' }]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
});

Deno.test('processLiveOutboundBatch emits non-visible event types immediately under egress', async () => {
  const profile = hostProfile('live_egress_nonvis', findNothing);
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
  const profile = hostProfile('live_no_text_field', findNothing);
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [{ type: 'text', text: '' }]);
  assertEquals(s.gate?.accumulated() ?? '', '');
});

Deno.test('processLiveOutboundBatch with canary+egress streams cleared prefixes', async () => {
  const profile = hostProfile('live_gate_hold', findNothing);
  const canary = mintCanary();
  const s = createLiveOutboundGateSession(profile, canary);
  assertEquals(s.gate !== null, true);
  const body = 'a'.repeat(HOST_FIND_HOLD_LIVE + 80);
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
  const result = await processLiveOutboundBatch(s, [{ type: 'text', text: 'a'.repeat(200) }]);
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

Deno.test("a find of the host's is told it reads a Live reply", async () => {
  // A find that throws blocks, so an emit says every call named the boundary.
  const profile = hostProfile('live_egress_ctx_verify', (_text, { boundary }) => {
    if (boundary !== 'live_reply') throw new Error('unexpected boundary');
    return [];
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
  await withheldAtEnd(s, result, canary.slice(half));
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

const guardrailTypes = (events: TurnEvent[]) => events.map((e) => e.type);

Deno.test('after a progressive hit, later audio and chunks stay held and the hit is reported once', async () => {
  const profile = hostProfile('live_egress_hit_then_more', findAll);
  const s = createLiveOutboundGateSession(profile);
  assertEquals(await processLiveOutboundBatch(s, [said(LONG)]), { action: 'idle' });
  assertEquals(s.withholdVisible, true);

  assertEquals(await processLiveOutboundBatch(s, [audio(1)]), { action: 'idle' });
  assertEquals(s.held.length, 2);
  assertEquals(await processLiveOutboundBatch(s, [said(' more')]), { action: 'idle' });
  assertEquals(s.gate?.accumulated(), `${LONG} more`);
  const end = await finalizeLiveOutboundTurn(s);
  assertEquals(end.action === 'withhold' && guardrailTypes(end.events ?? []), ['guardrail']);
});

Deno.test('a canary hit mid-batch shows nothing after it, and the cycle ends naming the canary', async () => {
  const s = session(FIXED_CANARY);
  const result = await processLiveOutboundBatch(s, [
    { type: 'text', text: FIXED_CANARY },
    { type: 'text', text: 'never reached' },
  ]);
  assertEquals(result, { action: 'idle' });
  const end = await withheldAtEnd(s, result, FIXED_CANARY);
  const reported = eventsOf(end.events ?? [], 'guardrail').map(({ guardrail }) => [
    guardrail.boundary,
    guardrail.action,
    guardrail.hits.map((hit) => hit.rule),
  ]);
  assertEquals(reported, [['live_reply', 'block', [DETECT_RULES.canary_leak]]]);
});

Deno.test('a canary in a non-stream event withholds with a guardrail event after what was already cleared', async () => {
  const s = session(FIXED_CANARY);
  const result = await processLiveOutboundBatch(s, [
    { type: 'text', text: 'safe words here' },
    { type: 'error', errorKind: 'internal', error: FIXED_CANARY },
  ]);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(guardrailTypes(result.events ?? []), ['text', 'guardrail']);
    assertEquals(result.error.kind, 'safety');
  }
});

Deno.test('a hit shows nothing of the reply, and a non-stream event after it still goes', async () => {
  const profile = hostProfile('live_egress_flush_hit', findAll, {
    leaks: 'ignore',
  });
  const s = createLiveOutboundGateSession(profile);
  const result = await processLiveOutboundBatch(s, [said(LONG), turnComplete]);
  assertEquals(result.action === 'emit' && guardrailTypes(result.events), ['session']);
});

Deno.test('a block at finalize keeps what the flush released, then the guardrail', async () => {
  const profile = hostProfile(
    'live_egress_final_block_prior',
    findWhere((text) => text.length > 20),
  );
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [said('x'.repeat(40))]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action, 'withhold');
  if (result.action === 'withhold') {
    assertEquals(result.error.kind, 'safety');
    assertEquals(guardrailTypes(result.events ?? []).at(-1), 'guardrail');
  }
});

Deno.test('a refusal at finalize carries the flush events before the guardrail and the text', async () => {
  const profile = hostProfile('live_egress_refuse_prior', findAll, {
    onBlock: 'refuse',
  });
  const s = createLiveOutboundGateSession(profile);
  await processLiveOutboundBatch(s, [said('hello')]);
  const result = await finalizeLiveOutboundTurn(s);
  assertEquals(result.action === 'emit' && guardrailTypes(result.events), ['guardrail', 'text']);
});

Deno.test('processLiveOutboundBatch catches a canary split across cycles', async () => {
  const canary = mintCanary();
  const s = session(canary);
  const half = CANARY_OPENING;
  await processLiveOutboundBatch(s, [said(`Part one: ${canary.slice(0, half)}`)]);
  assertEquals((await finalizeLiveOutboundTurn(s)).action, 'emit');
  // The session canary is stable: the next cycle reads the last one's opening first.
  const next = await processLiveOutboundBatch(s, [said(canary.slice(half))]);
  await withheldAtEnd(s, next, canary.slice(half));
});

Deno.test("a Live reply holds HOST_FIND_HOLD_LIVE for a find of the host's", async () => {
  const s = createLiveOutboundGateSession(hostProfile('live_hold_default', findNothing));
  await processLiveOutboundBatch(s, [said('s'.repeat(HOST_FIND_HOLD_LIVE * 3))]);
  assertEquals(s.gate?.unreleased().length, HOST_FIND_HOLD_LIVE);
});

Deno.test('a Live reply image renders once its URL is among those the session gave the model', async () => {
  // The host's own detector matches nothing: ungiven_images, left at its default, is what reads the image.
  const profile = hostProfile('live_egress_images', findNothing);
  const given = givenUrlSets();
  const image = '![p](https://news.site/photo.jpg)\n\nok';
  const withheld = createLiveOutboundGateSession(profile, undefined, undefined, given);
  await processLiveOutboundBatch(withheld, [{ type: 'text', text: image }]);
  assertEquals((await finalizeLiveOutboundTurn(withheld)).action, 'withhold');

  // The session adds URLs as tools and the user give them, after the gate opened.
  given.request.add('https://news.site/photo.jpg');
  const shown = createLiveOutboundGateSession(profile, undefined, undefined, given);
  const streamed = await processLiveOutboundBatch(shown, [{ type: 'text', text: image }]);
  const final = await finalizeLiveOutboundTurn(shown);
  const events = [streamed, final].flatMap((result) =>
    result.action === 'emit' ? result.events : [],
  );
  assertEquals([final.action === 'withhold', replyText(events)], [false, image]);
});

Deno.test('a thought is read on a session whose reply nothing reads', async () => {
  const ignored = Object.fromEntries(DETECTORS.map((detector) => [detector, 'ignore' as const]));
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: 'live_thought_only',
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: {
        quota: { perDay: 100 },
        detect: { ...ignored, credentials: { action: 'ignore', at: { thought: 'redact' } } },
      },
    }),
  );
  const s = createLiveOutboundGateSession(getProfile('live_thought_only'));
  assertEquals(s.gate, null);
  const batch = await processLiveOutboundBatch(s, [
    { type: 'thought', text: `The key is ${TEST_OPENAI_KEY} and that is all.` },
    { type: 'text', text: 'hi' },
  ]);
  const end = await finalizeLiveOutboundTurn(s);
  const events = [batch, end].flatMap((result) => (result.action === 'emit' ? result.events : []));
  const thought = eventsOf(events, 'thought')
    .map((event) => event.text)
    .join('');
  assertEquals(thought.includes(TEST_OPENAI_KEY), false);
  assertEquals(thought.includes('The key is'), true);
  assertEquals(replyText(events), 'hi');
});
