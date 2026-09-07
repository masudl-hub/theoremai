import '../fixtures/test-host.ts';
import { assertThrows } from '@std/assert';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { sanitizeTurnRequest } from '../../src/guardrails/sanitize.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  compactionMeter,
  compactionNeeded,
  estimateHistoryTokens,
  HISTORY_MEDIA_TOKENS,
  HISTORY_TEXT_ENCODING,
  resolveCompactionTokens,
  resolveHistoryTokens,
  shouldCompact,
  splitForCompaction,
} from '../../src/kernel/engine/compaction.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import {
  compactionMeter as publicCompactionMeter,
  compactionNeeded as publicCompactionNeeded,
  estimateHistoryTokens as publicEstimateHistoryTokens,
  HISTORY_MEDIA_TOKENS as publicMediaTokens,
  resolveCompactionTokens as publicResolveCompactionTokens,
  resolveHistoryTokens as publicResolveHistoryTokens,
  splitForCompaction as publicSplitForCompaction,
  HISTORY_TEXT_ENCODING as publicTextEncoding,
} from '../../src/kernel/mod.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type {
  CompactionSpec,
  ModelBinding,
  ModelProvider,
  TurnEvent,
  TurnHistoryMessage,
  TurnInput,
} from '../../src/kernel/types.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

function msg(role: TurnHistoryMessage['role'], content: string): TurnHistoryMessage {
  return { role, content };
}

function exchange(userText: string, assistantText: string): TurnHistoryMessage[] {
  return [msg('user', userText), msg('assistant', assistantText)];
}

/** Diverse text that o200k does not compress the way `'x'.repeat(n)` does. */
function bulky(repeats = 900): string {
  return 'word '.repeat(repeats);
}

const DEFAULT_SPEC: CompactionSpec = {
  maxTokens: 100_000,
  compactAt: 0.75,
  previousExchanges: 3,
  profile: 'test.compactor',
  timing: 'before',
};

// --- compactionNeeded ---

Deno.test('compactionNeeded returns true when tokens exceed threshold', () => {
  assertEquals(compactionNeeded(80_000, DEFAULT_SPEC), true);
});

Deno.test('compactionNeeded returns false when tokens are under threshold', () => {
  assertEquals(compactionNeeded(50_000, DEFAULT_SPEC), false);
});

Deno.test('compactionNeeded returns false at exact threshold', () => {
  assertEquals(compactionNeeded(75_000, DEFAULT_SPEC), false);
});

// --- resolveHistoryTokens ---

Deno.test('resolveHistoryTokens prefers host historyTokens over estimate', async () => {
  assertEquals(
    await resolveHistoryTokens({
      historyTokens: 12_345,
      history: [msg('user', 'short')],
    }),
    12_345,
  );
});

Deno.test('resolveHistoryTokens uses tiktoken o200k_base, not chars/4', async () => {
  const sample = 'x'.repeat(20);
  const bpe = encode(sample).length;
  assertEquals(bpe > 0, true);
  assertEquals(bpe !== Math.ceil(sample.length / 4), true);
  assertEquals(await resolveHistoryTokens({ history: [msg('user', sample)] }), bpe);
});

Deno.test('resolveHistoryTokens is 0 for empty or missing history', async () => {
  assertEquals(await resolveHistoryTokens(undefined), 0);
  assertEquals(await resolveHistoryTokens({}), 0);
  assertEquals(await resolveHistoryTokens({ history: [] }), 0);
});

Deno.test('resolveHistoryTokens ignores inputTokens under history meter', async () => {
  const input: TurnInput = {
    inputTokens: 50_000,
    history: [msg('user', 'abcd')],
  };
  assertEquals(await resolveHistoryTokens(input), encode('abcd').length);
});

// --- splitForCompaction with exchange count ---

Deno.test('splitForCompaction retains last N exchanges by count', async () => {
  const history = [
    ...exchange('hello', 'hi'),
    ...exchange('how are you', 'fine'),
    ...exchange('topic A', 'answer A'),
    ...exchange('topic B', 'answer B'),
    ...exchange('topic C', 'answer C'),
  ];

  const result = await splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 3 });
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 6);
  assertEquals(result.toRetain[0].content, 'topic A');
});

Deno.test('splitForCompaction retains all when fewer exchanges than requested', async () => {
  const history = [...exchange('hello', 'hi'), ...exchange('bye', 'later')];
  const result = await splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 5 });
  assertEquals(result.toCompact.length, 0);
  assertEquals(result.toRetain.length, 4);
});

// --- splitForCompaction with zero (compact all) ---

Deno.test('splitForCompaction compacts everything when previousExchanges is 0', async () => {
  const history = [...exchange('a', 'b'), ...exchange('c', 'd')];
  const result = await splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 0 });
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 0);
});

// --- splitForCompaction with fraction ---

Deno.test('splitForCompaction retains exchanges within token budget fraction', async () => {
  const shortExchange = exchange('hi', 'hello');
  const longExchange = exchange('x'.repeat(2000), 'y'.repeat(2000));
  const history = [...longExchange, ...shortExchange, ...shortExchange];

  const result = await splitForCompaction(history, {
    ...DEFAULT_SPEC,
    previousExchanges: 0.5,
    maxTokens: 100,
  });

  assertEquals(result.toRetain.length, 4);
  assertEquals(result.toCompact.length, 2);
});

Deno.test('splitForCompaction fraction counts media parts in the retain budget', async () => {
  const imageExchange: TurnHistoryMessage[] = [
    {
      role: 'user',
      parts: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(2000) }],
    },
    msg('assistant', 'ok'),
  ];
  const shortExchange = exchange('hi', 'hello');
  const result = await splitForCompaction([...imageExchange, ...shortExchange, ...shortExchange], {
    ...DEFAULT_SPEC,
    previousExchanges: 0.5,
    maxTokens: 100,
  });
  assertEquals(result.toRetain.length, 4);
  assertEquals(result.toCompact.length, 2);
});

// --- splitForCompaction with empty history ---

Deno.test('splitForCompaction handles empty history', async () => {
  const result = await splitForCompaction([], DEFAULT_SPEC);
  assertEquals(result.toCompact.length, 0);
  assertEquals(result.toRetain.length, 0);
});

// --- splitForCompaction preserves assistant multi-message exchanges ---

Deno.test('splitForCompaction groups tool messages with their exchange', async () => {
  const history: TurnHistoryMessage[] = [
    msg('user', 'search for plants'),
    msg('assistant', ''),
    { role: 'tool', tool_call_id: 'call_1', name: 'search', content: 'results...' },
    msg('assistant', 'Here are the results'),
    msg('user', 'thanks'),
    msg('assistant', 'welcome'),
  ];

  const result = await splitForCompaction(history, { ...DEFAULT_SPEC, previousExchanges: 1 });
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 2);
  assertEquals(result.toRetain[0].content, 'thanks');
});

// --- Profile registration validation ---

Deno.test('registerProfile rejects compactAt outside (0,1)', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      inputs: { text: true },
      id: 'compaction.validator.compactor',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
    }),
  );

  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          type: 'text',
          identity: { handle: 'test', system: 'test' },
          tools: { allow: [] },
          inputs: { text: true },
          id: 'compaction.validator.bad_compact_at',
          models: {
            testModel: {
              ...HOST_BINDINGS.gemini35FlashLite,
              compaction: {
                maxTokens: 100_000,
                compactAt: 1.5,
                previousExchanges: 5,
                profile: 'compaction.validator.compactor',
                timing: 'before',
              },
            },
          },
        }),
      ),
    Error,
    'compactAt must be in (0, 1)',
  );
});

Deno.test('registerProfile rejects previousExchanges fraction >= compactAt', () => {
  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          type: 'text',
          identity: { handle: 'test', system: 'test' },
          tools: { allow: [] },
          inputs: { text: true },
          id: 'compaction.validator.bad_prev_exchanges',
          models: {
            testModel: {
              ...HOST_BINDINGS.gemini35FlashLite,
              compaction: {
                maxTokens: 100_000,
                compactAt: 0.5,
                previousExchanges: 0.5,
                profile: 'compaction.validator.compactor',
                timing: 'before',
              },
            },
          },
        }),
      ),
    Error,
    'previousExchanges as fraction',
  );
});

Deno.test('registerProfile rejects non-integer previousExchanges >= 1', () => {
  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          type: 'text',
          identity: { handle: 'test', system: 'test' },
          tools: { allow: [] },
          inputs: { text: true },
          id: 'compaction.validator.bad_prev_exchanges_int',
          models: {
            testModel: {
              ...HOST_BINDINGS.gemini35FlashLite,
              compaction: {
                maxTokens: 100_000,
                compactAt: 0.75,
                previousExchanges: 3.5,
                profile: 'compaction.validator.compactor',
                timing: 'before',
              },
            },
          },
        }),
      ),
    Error,
    'previousExchanges >= 1 must be an integer',
  );
});

Deno.test('registerProfile rejects unregistered compaction profile', () => {
  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          type: 'text',
          identity: { handle: 'test', system: 'test' },
          tools: { allow: [] },
          inputs: { text: true },
          id: 'compaction.validator.missing_profile',
          models: {
            testModel: {
              ...HOST_BINDINGS.gemini35FlashLite,
              compaction: {
                maxTokens: 100_000,
                compactAt: 0.75,
                previousExchanges: 5,
                profile: 'nonexistent.compactor',
                timing: 'before',
              },
            },
          },
        }),
      ),
    Error,
    "compaction profile 'nonexistent.compactor' must be registered",
  );
});

function registerCompactionPair(
  prefix: string,
  compaction: Omit<CompactionSpec, 'profile'> & { profile?: string },
): string {
  const compactorId = `${prefix}.compactor`;
  const speakerId = `${prefix}.speaker`;
  const modelKey = `${prefix.replaceAll('.', '_')}Model`;
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: compactorId,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );
  const binding: ModelBinding = {
    ...HOST_BINDINGS.gemini35FlashLite,
    compaction: {
      ...compaction,
      profile: compaction.profile ?? compactorId,
    },
  };
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: speakerId,
      models: { [modelKey]: binding },
      key: 'slotA',
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );
  return speakerId;
}

function tokenProvider(inputTokens: number): ModelProvider {
  return {
    complete: () =>
      (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield {
          type: 'tokens' as const,
          tokens: { input: inputTokens, output: 50, total: inputTokens + 50 },
        };
        yield { type: 'done' as const };
      })(),
  };
}

async function collectEvents(
  profile: string,
  input: TurnInput,
  provider: ModelProvider,
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of runTurn({ profile, input }, provider)) {
    events.push(ev);
  }
  return events;
}

const SMALL_HISTORY = [...exchange('a', 'b'), ...exchange('c', 'd')];
const AFTER_SPEC = {
  maxTokens: 1000,
  compactAt: 0.5,
  previousExchanges: 2,
  timing: 'after' as const,
};
const BEFORE_SPEC = { ...AFTER_SPEC, timing: 'before' as const };

// --- Runner integration: timing 'before' ---

Deno.test('timing before compacts history before the turn', async () => {
  const speaker = registerCompactionPair('compaction.runner', BEFORE_SPEC);

  let compactionTurnFired = false;
  let callCount = 0;
  const mockProvider: ModelProvider = {
    complete: () => {
      callCount++;
      const isCompactionCall = callCount === 1;
      return (async function* () {
        if (isCompactionCall) {
          compactionTurnFired = true;
          yield { type: 'text' as const, text: 'Summary of old conversation' };
          yield { type: 'done' as const };
          return;
        }
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'tokens' as const, tokens: { input: 200, output: 50, total: 250 } };
        yield { type: 'done' as const };
      })();
    },
  };

  const events = await collectEvents(
    speaker,
    {
      text: 'new question',
      historyTokens: 600,
      history: [
        ...exchange('old topic 1', 'old answer 1'),
        ...exchange('old topic 2', 'old answer 2'),
        ...exchange('old topic 3', 'old answer 3'),
        ...exchange('recent 1', 'recent answer 1'),
        ...exchange('recent 2', 'recent answer 2'),
      ],
    },
    mockProvider,
  );

  assertEquals(compactionTurnFired, true);
  const textEvents = events.filter((e) => e.type === 'text');
  assertEquals(textEvents.length, 1);
  assertEquals(textEvents[0].text, 'response');
});

Deno.test('timing before estimates large history and does not require historyTokens', async () => {
  const speaker = registerCompactionPair('compaction.before.estimate', BEFORE_SPEC);

  let compactionTurnFired = false;
  let callCount = 0;
  const mockProvider: ModelProvider = {
    complete: () => {
      callCount++;
      if (callCount === 1) {
        compactionTurnFired = true;
        return (async function* () {
          yield { type: 'text' as const, text: 'Summary' };
          yield { type: 'done' as const };
        })();
      }
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const };
      })();
    },
  };

  await collectEvents(
    speaker,
    {
      text: 'new question',
      history: [
        ...exchange('x'.repeat(2000), 'y'.repeat(2000)),
        ...exchange('old 2', 'answer 2'),
        ...exchange('recent 1', 'recent answer 1'),
        ...exchange('recent 2', 'recent answer 2'),
      ],
    },
    mockProvider,
  );

  assertEquals(compactionTurnFired, true);
});

Deno.test('timing before ignores inputTokens and large provider tokens', async () => {
  const speaker = registerCompactionPair('compaction.before.ignore_api', BEFORE_SPEC);

  let callCount = 0;
  const mockProvider: ModelProvider = {
    complete: () => {
      callCount++;
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'tokens' as const, tokens: { input: 50_000, output: 50, total: 50_050 } };
        yield { type: 'done' as const };
      })();
    },
  };

  const events = await collectEvents(
    speaker,
    {
      text: 'new question',
      inputTokens: 50_000,
      history: SMALL_HISTORY,
    },
    mockProvider,
  );

  assertEquals(callCount, 1);
  assertEquals(events.filter((e) => e.type === 'text')[0].text, 'response');
  assertEquals(events.find((e) => e.type === 'tokens')?.tokens?.input, 50_000);
});

// --- Runner integration: timing 'after' ---

Deno.test('timing after emits compaction signal from host historyTokens', async () => {
  const speaker = registerCompactionPair('compaction.after', AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    {
      text: 'question',
      historyTokens: 800,
      history: SMALL_HISTORY,
    },
    tokenProvider(50_000),
  );

  const doneEvent = events.find((e) => e.type === 'done');
  const tokensEvent = events.find((e) => e.type === 'tokens');
  assertEquals(doneEvent?.compaction?.needed, true);
  assertEquals(doneEvent?.compaction?.meter, 'history');
  assertEquals(doneEvent?.compaction?.tokens, 800);
  assertEquals(doneEvent?.compaction?.promptTokens, 50_000);
  assertEquals(tokensEvent?.tokens?.input, 50_000);
});

Deno.test('timing after does not fire from large full-prompt token events', async () => {
  const speaker = registerCompactionPair('compaction.after.api_tokens', AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'question', history: SMALL_HISTORY },
    tokenProvider(50_000),
  );

  const doneEvent = events.find((e) => e.type === 'done');
  const tokensEvent = events.find((e) => e.type === 'tokens');
  assertEquals(doneEvent?.compaction, undefined);
  assertEquals(tokensEvent?.tokens?.input, 50_000);
});

Deno.test('timing after does not fire when host historyTokens is under threshold', async () => {
  const speaker = registerCompactionPair('compaction.after.under', AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    {
      text: 'question',
      historyTokens: 100,
      history: SMALL_HISTORY,
    },
    tokenProvider(50_000),
  );

  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('timing after does not fire for empty history', async () => {
  const speaker = registerCompactionPair('compaction.after.empty', AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'question', history: [], historyTokens: 800 },
    tokenProvider(50_000),
  );

  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('timing after does not fire for missing history', async () => {
  const speaker = registerCompactionPair('compaction.after.missing', AFTER_SPEC);
  const events = await collectEvents(speaker, { text: 'question' }, tokenProvider(50_000));

  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('timing after fires from history estimate without historyTokens', async () => {
  const speaker = registerCompactionPair('compaction.after.estimate', AFTER_SPEC);
  const longHistory = [...exchange(bulky(400), bulky(400)), ...exchange('c', 'd')];
  const events = await collectEvents(
    speaker,
    { text: 'question', history: longHistory },
    tokenProvider(50_000),
  );

  const doneEvent = events.find((e) => e.type === 'done');
  assertEquals(doneEvent?.compaction?.needed, true);
  assertEquals(doneEvent?.compaction?.tokens, await resolveHistoryTokens({ history: longHistory }));
  assertEquals(doneEvent?.compaction?.promptTokens, 50_000);
  assertEquals(doneEvent?.compaction?.meter, 'history');
});

// --- Pressure: Orchid-shaped profile, estimator, fallback tokens, overrides ---

const ORCHID_SPEC = {
  maxTokens: 2000,
  compactAt: 0.75,
  previousExchanges: 8,
  timing: 'after' as const,
};
const ORCHID_THRESHOLD = 0.75 * 2000; // 1500

Deno.test('orchid 2000@0.75 threshold is strict greater-than 1500', () => {
  const spec: CompactionSpec = { ...ORCHID_SPEC, profile: 'x', timing: 'after' };
  for (let t = 0; t <= 3000; t++) {
    assertEquals(compactionNeeded(t, spec), t > ORCHID_THRESHOLD);
  }
  assertEquals(ORCHID_THRESHOLD, 1500);
  assertEquals(compactionNeeded(1500, spec), false);
  assertEquals(compactionNeeded(1501, spec), true);
});

Deno.test('resolveHistoryTokens counts text parts, media stubs, and tool_call arguments', async () => {
  assertEquals(
    await resolveHistoryTokens({
      history: [{ role: 'user', parts: [{ type: 'text', text: 'abcdefgh' }] }],
    }),
    encode('abcdefgh').length,
  );
  assertEquals(
    await resolveHistoryTokens({
      history: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'search', arguments: 'abcd' },
            },
          ],
        },
      ],
    }),
    encode('abcd').length,
  );
  assertEquals(
    await resolveHistoryTokens({
      history: [
        {
          role: 'user',
          parts: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(4000) }],
        },
      ],
    }),
    HISTORY_MEDIA_TOKENS.image,
  );
  assertEquals(
    await resolveHistoryTokens({
      history: [
        {
          role: 'user',
          parts: [{ type: 'image', mimeType: 'image/png', data: '' }],
        },
      ],
    }),
    HISTORY_MEDIA_TOKENS.image,
  );
  assertEquals(
    await resolveHistoryTokens({
      history: [
        {
          role: 'user',
          parts: [{ type: 'video', mimeType: 'video/mp4', data: 'v'.repeat(12) }],
        },
      ],
    }),
    HISTORY_MEDIA_TOKENS.video,
  );
  assertEquals(
    await resolveHistoryTokens({
      history: [
        {
          role: 'user',
          parts: [{ type: 'audio', mimeType: 'audio/wav', data: '' }],
        },
      ],
    }),
    HISTORY_MEDIA_TOKENS.audio,
  );
  assertEquals(
    await resolveHistoryTokens({
      history: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'abcd' },
            { type: 'image', mimeType: 'image/png', data: 'efgh' },
          ],
        },
      ],
    }),
    encode('abcd').length + HISTORY_MEDIA_TOKENS.image,
  );
});

Deno.test('resolveHistoryTokens: historyTokens 0 wins over a large estimate', async () => {
  assertEquals(
    await resolveHistoryTokens({
      historyTokens: 0,
      history: [msg('user', 'x'.repeat(8000))],
    }),
    0,
  );
});

Deno.test('resolveHistoryTokens: inputTokens does not suppress a large estimate', async () => {
  const history = [msg('user', 'abcdefgh')];
  assertEquals(await resolveHistoryTokens({ inputTokens: 1, history }), encode('abcdefgh').length);
});

Deno.test('public barrel re-exports compaction helpers', () => {
  assertEquals(publicCompactionNeeded, compactionNeeded);
  assertEquals(publicResolveHistoryTokens, resolveHistoryTokens);
  assertEquals(publicResolveCompactionTokens, resolveCompactionTokens);
  assertEquals(publicCompactionMeter, compactionMeter);
  assertEquals(publicSplitForCompaction, splitForCompaction);
  assertEquals(publicEstimateHistoryTokens, estimateHistoryTokens);
  assertEquals(publicMediaTokens, HISTORY_MEDIA_TOKENS);
  assertEquals(publicTextEncoding, HISTORY_TEXT_ENCODING);
  assertEquals(HISTORY_TEXT_ENCODING, 'o200k_base');
  assertEquals(HISTORY_MEDIA_TOKENS.image, 258);
  assertEquals(HISTORY_MEDIA_TOKENS.audio, 32);
  assertEquals(HISTORY_MEDIA_TOKENS.video, 263);
  assertEquals(compactionMeter(DEFAULT_SPEC), 'history');
});

Deno.test('sanitizeTurnRequest preserves historyTokens and inputTokens', () => {
  const speaker = registerCompactionPair('compaction.sanitize.tokens', ORCHID_SPEC);
  const safe = sanitizeTurnRequest({
    profile: speaker,
    input: {
      text: 'hi',
      historyTokens: 1501,
      inputTokens: 99_999,
      history: SMALL_HISTORY,
    },
  });
  assertEquals(safe.input.historyTokens, 1501);
  assertEquals(safe.input.inputTokens, 99_999);
});

Deno.test('orchid after: many history media parts fire; payload size does not', async () => {
  const speaker = registerCompactionPair('compaction.orchid.image', ORCHID_SPEC);
  const oneHuge: TurnHistoryMessage[] = [
    {
      role: 'user',
      parts: [{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(6002) }],
    },
    msg('assistant', 'ok'),
  ];
  const manyStubs: TurnHistoryMessage[] = [
    {
      role: 'user',
      parts: Array.from({ length: 6 }, () => ({
        type: 'image' as const,
        mimeType: 'image/png',
        data: '',
      })),
    },
    msg('assistant', 'ok'),
  ];
  const hugeEvents = await collectEvents(
    speaker,
    { text: 'q', history: oneHuge },
    tokenProvider(12),
  );
  const stubEvents = await collectEvents(
    speaker,
    { text: 'q', history: manyStubs },
    tokenProvider(12),
  );
  assertEquals(hugeEvents.find((e) => e.type === 'done')?.compaction, undefined);
  assertEquals(stubEvents.find((e) => e.type === 'done')?.compaction?.needed, true);
  assertEquals(
    stubEvents.find((e) => e.type === 'done')?.compaction?.tokens,
    await resolveHistoryTokens({ history: manyStubs }),
  );
});

Deno.test('orchid after: API prompt tokens over 1500 with short history do not fire', async () => {
  const speaker = registerCompactionPair('compaction.orchid.api', ORCHID_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'question', inputTokens: 50_000, history: SMALL_HISTORY },
    tokenProvider(50_000),
  );
  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
  assertEquals(events.find((e) => e.type === 'tokens')?.tokens?.input, 50_000);
});

Deno.test('orchid after: historyTokens 1501 fires; 1500 does not', async () => {
  const over = registerCompactionPair('compaction.orchid.over', ORCHID_SPEC);
  const under = registerCompactionPair('compaction.orchid.exact', ORCHID_SPEC);
  const overEvents = await collectEvents(
    over,
    { text: 'q', historyTokens: 1501, history: SMALL_HISTORY },
    tokenProvider(12),
  );
  const exactEvents = await collectEvents(
    under,
    { text: 'q', historyTokens: 1500, history: SMALL_HISTORY },
    tokenProvider(12),
  );
  assertEquals(overEvents.find((e) => e.type === 'done')?.compaction?.needed, true);
  assertEquals(overEvents.find((e) => e.type === 'done')?.compaction?.tokens, 1501);
  assertEquals(overEvents.find((e) => e.type === 'done')?.compaction?.promptTokens, 12);
  assertEquals(exactEvents.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('orchid after: huge current-turn text is not in the history meter', async () => {
  const speaker = registerCompactionPair('compaction.orchid.turn_text', ORCHID_SPEC);
  const events = await collectEvents(
    speaker,
    {
      text: 'z'.repeat(20_000),
      historyTokens: 1499,
      history: SMALL_HISTORY,
    },
    tokenProvider(20_000),
  );
  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('orchid after: historyTokens 0 blocks fire despite huge history', async () => {
  const speaker = registerCompactionPair('compaction.orchid.zero', ORCHID_SPEC);
  const events = await collectEvents(
    speaker,
    {
      text: 'q',
      historyTokens: 0,
      history: [...exchange('x'.repeat(4000), 'y'.repeat(4000))],
    },
    tokenProvider(50_000),
  );
  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('orchid after: inputTokens under threshold does not hide a large history estimate', async () => {
  const speaker = registerCompactionPair('compaction.orchid.estimate_vs_last', ORCHID_SPEC);
  const longHistory = [...exchange(bulky(), bulky())];
  const events = await collectEvents(
    speaker,
    { text: 'q', inputTokens: 1, history: longHistory },
    tokenProvider(1),
  );
  const done = events.find((e) => e.type === 'done');
  assertEquals(done?.compaction?.needed, true);
  assertEquals(done?.compaction?.tokens, await resolveHistoryTokens({ history: longHistory }));
  assertEquals(done?.compaction?.promptTokens, 1);
});

Deno.test('orchid after: fallback prompt tokens from a long system prompt do not gate', async () => {
  const compactorId = 'compaction.orchid.fallback.compactor';
  const speakerId = 'compaction.orchid.fallback.speaker';
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: compactorId,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );
  registerProfile(
    defineProfile({
      type: 'text',
      tools: { allow: [] },
      id: speakerId,
      identity: { handle: 'speaker', system: 'S'.repeat(20_000) },
      models: {
        fallbackModel: {
          ...HOST_BINDINGS.gemini35FlashLite,
          compaction: { ...ORCHID_SPEC, profile: compactorId },
        },
      },
      key: 'slotA',
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    { profile: speakerId, input: { text: 'q', history: SMALL_HISTORY } },
    {
      complete: () =>
        (async function* () {
          yield { type: 'text' as const, text: 'response' };
          yield { type: 'done' as const };
        })(),
    },
  )) {
    events.push(ev);
  }

  const tokensEvent = events.find((e) => e.type === 'tokens');
  const doneEvent = events.find((e) => e.type === 'done');
  const fallbackInput = tokensEvent?.tokens?.input ?? 0;
  assertEquals(fallbackInput > ORCHID_THRESHOLD, true);
  assertEquals(doneEvent?.compaction, undefined);
  assertEquals(doneEvent?.compaction?.promptTokens, undefined);
});

Deno.test('orchid after: signal history is request history, not this turn output', async () => {
  const speaker = registerCompactionPair('compaction.orchid.signal_hist', ORCHID_SPEC);
  const history = [...exchange('old 1', 'a1'), ...exchange('old 2', 'a2')];
  const events = await collectEvents(
    speaker,
    { text: 'new question', historyTokens: 1501, history },
    tokenProvider(9),
  );
  const signal = events.find((e) => e.type === 'done')?.compaction;
  assertEquals(signal?.needed, true);
  assertEquals(signal?.history, history);
  assertEquals(
    events.some((e) => e.type === 'text' && e.text === 'response'),
    true,
  );
});

Deno.test('orchid previousExchanges 8 keeps last 8 of 10 exchanges', async () => {
  const spec: CompactionSpec = { ...ORCHID_SPEC, profile: 'x' };
  const history = Array.from({ length: 10 }, (_, i) => exchange(`u${i}`, `a${i}`)).flat();
  const { toCompact, toRetain } = await splitForCompaction(history, spec);
  assertEquals(toCompact.length, 4);
  assertEquals(toRetain.length, 16);
  assertEquals(toRetain[0].content, 'u2');
});

Deno.test('timing after omits promptTokens when provider reports input 0', async () => {
  const speaker = registerCompactionPair('compaction.after.prompt0', AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'q', historyTokens: 800, history: SMALL_HISTORY },
    tokenProvider(0),
  );
  const signal = events.find((e) => e.type === 'done')?.compaction;
  assertEquals(signal?.needed, true);
  assertEquals(signal?.tokens, 800);
  assertEquals(signal?.promptTokens, undefined);
});

Deno.test('timing before: historyTokens 0 skips nested compact on large history', async () => {
  const speaker = registerCompactionPair('compaction.before.zero', BEFORE_SPEC);
  let callCount = 0;
  const provider: ModelProvider = {
    complete: () => {
      callCount++;
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const };
      })();
    },
  };
  await collectEvents(
    speaker,
    {
      text: 'q',
      historyTokens: 0,
      history: [
        ...exchange('x'.repeat(2000), 'y'.repeat(2000)),
        ...exchange('a', 'b'),
        ...exchange('c', 'd'),
        ...exchange('e', 'f'),
      ],
    },
    provider,
  );
  assertEquals(callCount, 1);
});

Deno.test('nested compacting turn does not recurse even if compacting profile has compaction', async () => {
  const leaf = 'compaction.nested.leaf';
  const mid = 'compaction.nested.mid';
  const speaker = 'compaction.nested.speaker';
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: leaf,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: mid,
      models: {
        midModel: {
          ...HOST_BINDINGS.gemini35FlashLite,
          compaction: {
            maxTokens: 10,
            compactAt: 0.1,
            previousExchanges: 1,
            profile: leaf,
            timing: 'before',
          },
        },
      },
      maxSteps: 1,
      key: 'slotA',
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id: speaker,
      models: {
        nestModel: {
          ...HOST_BINDINGS.gemini35FlashLite,
          compaction: {
            maxTokens: 1000,
            compactAt: 0.5,
            previousExchanges: 2,
            profile: mid,
            timing: 'before',
          },
        },
      },
      key: 'slotA',
      inputs: { text: true },
      guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
    }),
  );

  const profiles: string[] = [];
  const provider: ModelProvider = {
    complete: (req) => {
      profiles.push(req.model);
      return (async function* () {
        yield { type: 'text' as const, text: 'ok' };
        yield { type: 'done' as const };
      })();
    },
  };

  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: speaker,
      input: {
        text: 'q',
        historyTokens: 600,
        history: [
          ...exchange('old 1', 'a1'),
          ...exchange('old 2', 'a2'),
          ...exchange('old 3', 'a3'),
          ...exchange('r1', 'ra1'),
          ...exchange('r2', 'ra2'),
        ],
      },
    },
    provider,
  )) {
    events.push(ev);
  }

  assertEquals(profiles.length, 2);
  assertEquals(
    events.filter((e) => e.type === 'text').map((e) => e.text),
    ['ok'],
  );
});

// --- meter: 'input' ---

const INPUT_AFTER_SPEC = {
  maxTokens: 1000,
  compactAt: 0.5,
  previousExchanges: 2,
  timing: 'after' as const,
  meter: 'input' as const,
};
const INPUT_BEFORE_SPEC = { ...INPUT_AFTER_SPEC, timing: 'before' as const };

Deno.test('resolveCompactionTokens input meter prefers promptTokens then host inputTokens', async () => {
  const spec: CompactionSpec = { ...INPUT_AFTER_SPEC, profile: 'x' };
  assertEquals(
    await resolveCompactionTokens({
      spec,
      input: { inputTokens: 100 },
      promptTokens: 900,
    }),
    { meter: 'input', tokens: 900 },
  );
  assertEquals(await resolveCompactionTokens({ spec, input: { inputTokens: 100 } }), {
    meter: 'input',
    tokens: 100,
  });
  assertEquals(await resolveCompactionTokens({ spec, input: {} }), undefined);
  assertEquals(
    await resolveCompactionTokens({
      spec: { ...DEFAULT_SPEC, meter: 'history' },
      input: { history: [msg('user', 'abcd')], inputTokens: 50_000 },
    }),
    { meter: 'history', tokens: encode('abcd').length },
  );
});

Deno.test('shouldCompact uses default threshold when trigger is omitted', async () => {
  assertEquals(await shouldCompact({ meter: 'history', tokens: 80_000 }, DEFAULT_SPEC), true);
  assertEquals(await shouldCompact({ meter: 'history', tokens: 50_000 }, DEFAULT_SPEC), false);
});

Deno.test('shouldCompact defers to custom trigger', async () => {
  const forcedOff: CompactionSpec = {
    ...DEFAULT_SPEC,
    trigger: () => false,
  };
  const forcedOn: CompactionSpec = {
    ...DEFAULT_SPEC,
    trigger: (ctx) => ctx.tokens > 10,
  };
  assertEquals(await shouldCompact({ meter: 'history', tokens: 99_999 }, forcedOff), false);
  assertEquals(await shouldCompact({ meter: 'history', tokens: 11 }, forcedOn), true);
  assertEquals(await shouldCompact({ meter: 'history', tokens: 5 }, forcedOn), false);
});

Deno.test('shouldCompact awaits async trigger', async () => {
  const spec: CompactionSpec = {
    ...DEFAULT_SPEC,
    trigger: async (ctx) => {
      await Promise.resolve();
      return ctx.meter === 'input' && ctx.tokens > ctx.compactAt * ctx.maxTokens;
    },
  };
  assertEquals(await shouldCompact({ meter: 'input', tokens: 80_000 }, spec), true);
});

Deno.test('estimateHistoryTokens media-only history does not require host historyTokens', async () => {
  const tokens = await estimateHistoryTokens([
    {
      role: 'user',
      parts: [{ type: 'image', mimeType: 'image/png', data: '' }],
    },
  ]);
  assertEquals(tokens, HISTORY_MEDIA_TOKENS.image);
});

Deno.test('meter input after fires from provider tokens.input', async () => {
  const speaker = registerCompactionPair('compaction.input.after', INPUT_AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'q', history: SMALL_HISTORY },
    tokenProvider(800),
  );
  const done = events.find((e) => e.type === 'done');
  assertEquals(done?.compaction?.needed, true);
  assertEquals(done?.compaction?.meter, 'input');
  assertEquals(done?.compaction?.tokens, 800);
  assertEquals(done?.compaction?.promptTokens, 800);
});

Deno.test('meter input after does not fire when provider tokens are under threshold', async () => {
  const speaker = registerCompactionPair('compaction.input.after.under', INPUT_AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'q', history: SMALL_HISTORY, historyTokens: 50_000 },
    tokenProvider(100),
  );
  assertEquals(events.find((e) => e.type === 'done')?.compaction, undefined);
});

Deno.test('meter input before compacts when host inputTokens exceed threshold', async () => {
  const speaker = registerCompactionPair('compaction.input.before', INPUT_BEFORE_SPEC);
  let compactionTurnFired = false;
  let callCount = 0;
  const provider: ModelProvider = {
    complete: () => {
      callCount++;
      if (callCount === 1) {
        compactionTurnFired = true;
        return (async function* () {
          yield { type: 'text' as const, text: 'Summary' };
          yield { type: 'done' as const };
        })();
      }
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const };
      })();
    },
  };
  await collectEvents(
    speaker,
    {
      text: 'q',
      inputTokens: 600,
      history: [
        ...exchange('old 1', 'a1'),
        ...exchange('old 2', 'a2'),
        ...exchange('old 3', 'a3'),
        ...exchange('r1', 'ra1'),
        ...exchange('r2', 'ra2'),
      ],
    },
    provider,
  );
  assertEquals(compactionTurnFired, true);
});

Deno.test('meter input before does not compact without inputTokens even if history is large', async () => {
  const speaker = registerCompactionPair('compaction.input.before.missing', INPUT_BEFORE_SPEC);
  let callCount = 0;
  const provider: ModelProvider = {
    complete: () => {
      callCount++;
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const };
      })();
    },
  };
  await collectEvents(
    speaker,
    {
      text: 'q',
      historyTokens: 50_000,
      history: [
        ...exchange(bulky(400), bulky(400)),
        ...exchange('old 2', 'a2'),
        ...exchange('r1', 'ra1'),
        ...exchange('r2', 'ra2'),
      ],
    },
    provider,
  );
  assertEquals(callCount, 1);
});
