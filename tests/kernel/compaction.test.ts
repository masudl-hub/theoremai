import '../fixtures/test-host.ts';
import { assertRejects, assertThrows } from '@std/assert';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { TheoremError } from '../../src/guardrails/error.ts';
import { sanitizeTurnRequest } from '../../src/guardrails/sanitize.ts';
import {
  compactHistory,
  getProfile,
  registerProfile,
  runTurn,
} from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  compactionMeter,
  compactionNeeded,
  compactorHistory,
  resolveCompactionTokens,
  resolveHistoryTokens,
  shouldCompact,
  splitForCompaction,
} from '../../src/kernel/engine/compaction.ts';
import {
  compactionMeter as publicCompactionMeter,
  compactionNeeded as publicCompactionNeeded,
  resolveCompactionTokens as publicResolveCompactionTokens,
  resolveHistoryTokens as publicResolveHistoryTokens,
  splitForCompaction as publicSplitForCompaction,
} from '../../src/kernel/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type {
  CompactionSpec,
  ModelBinding,
  ModelProvider,
  ProviderCompleteRequest,
  ProviderEvent,
  TurnEvent,
  TurnHistoryMessage,
  TurnInput,
} from '../../src/kernel/types.ts';
import { bytesToBase64 } from '../../src/kernel/util/base64.ts';
import { contentOf, type TraceRecord } from '../../src/observability/trace-record.ts';
import type { TraceAttributes } from '../../src/observability/trace-span.ts';
import { eventsOf, firstOf } from '../fixtures/events.ts';
import { pngBytes } from '../fixtures/media-bytes.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';

/** Media family of the fixture speaker model (`gemini-3.5-flash-lite`). */
const FAMILY = 'gemini-3' as const;
/** Live `countTokens` for a 1920×1080 image on Gemini 3 (22/09/2026). */
const HD_IMAGE_TOKENS = 1100;

function hdImage(): { type: 'image'; mimeType: string; data: string } {
  return { type: 'image', mimeType: 'image/png', data: bytesToBase64(pngBytes(1920, 1080)) };
}

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

Deno.test('compactionNeeded returns true when tokens exceed threshold', () => {
  assertEquals(compactionNeeded(80_000, DEFAULT_SPEC), true);
});

Deno.test('compactionNeeded returns false when tokens are under threshold', () => {
  assertEquals(compactionNeeded(50_000, DEFAULT_SPEC), false);
});

Deno.test('compactionNeeded returns false at exact threshold', () => {
  assertEquals(compactionNeeded(75_000, DEFAULT_SPEC), false);
});

Deno.test('resolveHistoryTokens prefers host historyTokens over estimate', async () => {
  assertEquals(
    await resolveHistoryTokens({ historyTokens: 12_345, history: [msg('user', 'short')] }, FAMILY),
    { tokens: 12_345, unknownMedia: 0 },
  );
});

Deno.test('resolveHistoryTokens uses tiktoken o200k_base, not chars/4', async () => {
  const sample = 'x'.repeat(20);
  const bpe = encode(sample).length;
  assertEquals(bpe > 0, true);
  assertEquals(bpe !== Math.ceil(sample.length / 4), true);
  assertEquals(await resolveHistoryTokens({ history: [msg('user', sample)] }, FAMILY), {
    tokens: bpe,
    unknownMedia: 0,
  });
});

Deno.test('resolveHistoryTokens is 0 for empty or missing history', async () => {
  const none = { tokens: 0, unknownMedia: 0 };
  assertEquals(await resolveHistoryTokens(undefined, FAMILY), none);
  assertEquals(await resolveHistoryTokens({}, FAMILY), none);
  assertEquals(await resolveHistoryTokens({ history: [] }, FAMILY), none);
});

Deno.test('resolveHistoryTokens ignores inputTokens under history meter', async () => {
  const input: TurnInput = {
    inputTokens: 50_000,
    history: [msg('user', 'abcd')],
  };
  assertEquals(await resolveHistoryTokens(input, FAMILY), {
    tokens: encode('abcd').length,
    unknownMedia: 0,
  });
});

Deno.test('splitForCompaction retains last N exchanges by count', async () => {
  const history = [
    ...exchange('hello', 'hi'),
    ...exchange('how are you', 'fine'),
    ...exchange('topic A', 'answer A'),
    ...exchange('topic B', 'answer B'),
    ...exchange('topic C', 'answer C'),
  ];

  const result = await splitForCompaction(
    history,
    { ...DEFAULT_SPEC, previousExchanges: 3 },
    FAMILY,
  );
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 6);
  assertEquals(result.toRetain[0].content, 'topic A');
});

Deno.test('splitForCompaction retains all when fewer exchanges than requested', async () => {
  const history = [...exchange('hello', 'hi'), ...exchange('bye', 'later')];
  const result = await splitForCompaction(
    history,
    { ...DEFAULT_SPEC, previousExchanges: 5 },
    FAMILY,
  );
  assertEquals(result.toCompact.length, 0);
  assertEquals(result.toRetain.length, 4);
});

Deno.test('splitForCompaction compacts everything when previousExchanges is 0', async () => {
  const history = [...exchange('a', 'b'), ...exchange('c', 'd')];
  const result = await splitForCompaction(
    history,
    { ...DEFAULT_SPEC, previousExchanges: 0 },
    FAMILY,
  );
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 0);
});

Deno.test('splitForCompaction retains exchanges within token budget fraction', async () => {
  const shortExchange = exchange('hi', 'hello');
  const longExchange = exchange('x'.repeat(2000), 'y'.repeat(2000));
  const history = [...longExchange, ...shortExchange, ...shortExchange];

  const result = await splitForCompaction(
    history,
    { ...DEFAULT_SPEC, previousExchanges: 0.5, maxTokens: 100 },
    FAMILY,
  );

  assertEquals(result.toRetain.length, 4);
  assertEquals(result.toCompact.length, 2);
});

Deno.test('splitForCompaction fraction counts media parts in the retain budget', async () => {
  const imageExchange: TurnHistoryMessage[] = [
    { role: 'user', parts: [hdImage()] },
    msg('assistant', 'ok'),
  ];
  const shortExchange = exchange('hi', 'hello');
  const result = await splitForCompaction(
    [...imageExchange, ...shortExchange, ...shortExchange],
    { ...DEFAULT_SPEC, previousExchanges: 0.5, maxTokens: 2 * HD_IMAGE_TOKENS },
    FAMILY,
  );
  assertEquals(result.toRetain.length, 4);
  assertEquals(result.toCompact.length, 2);
});

Deno.test('splitForCompaction handles empty history', async () => {
  const result = await splitForCompaction([], DEFAULT_SPEC, FAMILY);
  assertEquals(result.toCompact.length, 0);
  assertEquals(result.toRetain.length, 0);
});

Deno.test('splitForCompaction groups tool messages with their exchange', async () => {
  const history: TurnHistoryMessage[] = [
    msg('user', 'search for plants'),
    msg('assistant', ''),
    { role: 'tool', tool_call_id: 'call_1', name: 'search', content: 'results...' },
    msg('assistant', 'Here are the results'),
    msg('user', 'thanks'),
    msg('assistant', 'welcome'),
  ];

  const result = await splitForCompaction(
    history,
    { ...DEFAULT_SPEC, previousExchanges: 1 },
    FAMILY,
  );
  assertEquals(result.toCompact.length, 4);
  assertEquals(result.toRetain.length, 2);
  assertEquals(result.toRetain[0].content, 'thanks');
});

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
          key: 'slotA',
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
          key: 'slotA',
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
          key: 'slotA',
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
          key: 'slotA',
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
  compactor: Record<string, unknown> = {},
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
      ...compactor,
    } as Parameters<typeof defineProfile>[0]),
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
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
          yield { type: 'done' as const, stop: { kind: 'completed' } };
          return;
        }
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'tokens' as const, tokens: { input: 200, output: 50, total: 250 } };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
  const textEvents = eventsOf(events, 'text');
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
          yield { type: 'done' as const, stop: { kind: 'completed' } };
        })();
      }
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
  assertEquals(eventsOf(events, 'text')[0].text, 'response');
  assertEquals(firstOf(events, 'tokens')?.tokens?.input, 50_000);
});

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

  const doneEvent = firstOf(events, 'done');
  const tokensEvent = firstOf(events, 'tokens');
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

  const doneEvent = firstOf(events, 'done');
  const tokensEvent = firstOf(events, 'tokens');
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

  assertEquals(firstOf(events, 'done')?.compaction, undefined);
});

Deno.test('timing after does not fire for empty history', async () => {
  const speaker = registerCompactionPair('compaction.after.empty', AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'question', history: [], historyTokens: 800 },
    tokenProvider(50_000),
  );

  assertEquals(firstOf(events, 'done')?.compaction, undefined);
});

Deno.test('timing after does not fire for missing history', async () => {
  const speaker = registerCompactionPair('compaction.after.missing', AFTER_SPEC);
  const events = await collectEvents(speaker, { text: 'question' }, tokenProvider(50_000));

  assertEquals(firstOf(events, 'done')?.compaction, undefined);
});

Deno.test('timing after fires from history estimate without historyTokens', async () => {
  const speaker = registerCompactionPair('compaction.after.estimate', AFTER_SPEC);
  const longHistory = [...exchange(bulky(400), bulky(400)), ...exchange('c', 'd')];
  const events = await collectEvents(
    speaker,
    { text: 'question', history: longHistory },
    tokenProvider(50_000),
  );

  const doneEvent = firstOf(events, 'done');
  assertEquals(doneEvent?.compaction?.needed, true);
  assertEquals(
    doneEvent?.compaction?.tokens,
    (await resolveHistoryTokens({ history: longHistory }, FAMILY)).tokens,
  );
  assertEquals(doneEvent?.compaction?.promptTokens, 50_000);
  assertEquals(doneEvent?.compaction?.meter, 'history');
});

async function tracedTurn(
  profile: string,
  input: TurnInput,
  provider: ModelProvider,
): Promise<{ record: TraceRecord; decision: TraceAttributes | undefined }> {
  const records: TraceRecord[] = [];
  for await (const _ of runTurn({ profile, input }, provider, catalogedSink(records))) {
    // drain
  }
  const [record] = records;
  if (!record) throw new Error('no record');
  const decision = record.spans[0]?.events.find((e) => e.name === 'theorem.compaction');
  return { record, decision: decision?.attributes };
}

Deno.test('a compaction that ran records its decision, what it replaced, and the summary', async () => {
  const speaker = registerCompactionPair('compaction.trace.before', BEFORE_SPEC);
  let calls = 0;
  const provider: ModelProvider = {
    complete: () => {
      calls++;
      const text = calls === 1 ? 'Summary of old conversation' : 'response';
      return (async function* () {
        yield { type: 'text' as const, text };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })();
    },
  };
  const history = [
    ...exchange('old 1', 'answer 1'),
    ...exchange('old 2', 'answer 2'),
    ...exchange('recent 1', 'recent answer 1'),
    ...exchange('recent 2', 'recent answer 2'),
  ];
  const { record, decision } = await tracedTurn(
    speaker,
    { text: 'new question', historyTokens: 600, history },
    provider,
  );
  const { summary, ...rest } = decision ?? {};
  assertEquals(rest, {
    timing: 'before',
    meter: 'history',
    budget: 1000,
    threshold: 0.5,
    tokens_before: 600,
    unknown_media: 0,
    needed: true,
    outcome: 'compacted',
    messages_before: 8,
    messages_after: 5,
    dropped_media: 0,
  });
  assertEquals(contentOf(record, summary), 'Summary of old conversation');
  assertEquals(record.spans[0]?.attributes['gen_ai.conversation.compacted'], true);
});

Deno.test('a compaction that was not needed still records the count it compared', async () => {
  const speaker = registerCompactionPair('compaction.trace.after', AFTER_SPEC);
  const { decision } = await tracedTurn(
    speaker,
    { text: 'question', historyTokens: 100, history: SMALL_HISTORY },
    tokenProvider(50_000),
  );
  assertEquals(decision, {
    timing: 'after',
    meter: 'history',
    budget: 1000,
    threshold: 0.5,
    tokens_before: 100,
    unknown_media: 0,
    needed: false,
  });
});

Deno.test('a compaction with no count to meter records the count as absent', async () => {
  const speaker = registerCompactionPair('compaction.trace.unknown', {
    ...BEFORE_SPEC,
    meter: 'input',
  });
  const { decision } = await tracedTurn(
    speaker,
    { text: 'question', history: SMALL_HISTORY },
    tokenProvider(50),
  );
  assertEquals(decision, {
    timing: 'before',
    meter: 'input',
    budget: 1000,
    threshold: 0.5,
    needed: false,
  });
});

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

Deno.test('resolveHistoryTokens counts text parts, tool_call arguments, and verified media', async () => {
  const count = (history: TurnHistoryMessage[]) => resolveHistoryTokens({ history }, FAMILY);
  assertEquals(await count([{ role: 'user', parts: [{ type: 'text', text: 'abcdefgh' }] }]), {
    tokens: encode('abcdefgh').length,
    unknownMedia: 0,
  });
  assertEquals(
    await count([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: 'abcd' } },
        ],
      },
    ]),
    { tokens: encode('search').length + encode('abcd').length, unknownMedia: 0 },
  );
  assertEquals(
    await count([{ role: 'user', parts: [{ type: 'text', text: 'abcd' }, hdImage()] }]),
    { tokens: encode('abcd').length + HD_IMAGE_TOKENS, unknownMedia: 0 },
  );
});

Deno.test('resolveHistoryTokens reports media it cannot count instead of guessing', async () => {
  const unreadable: TurnHistoryMessage[] = [
    {
      role: 'user',
      parts: [
        { type: 'image', mimeType: 'image/png', data: '' },
        { type: 'video', mimeType: 'video/mp4', data: 'dmlkZW8=' },
        { type: 'text', text: 'abcd' },
      ],
    },
  ];
  assertEquals(await resolveHistoryTokens({ history: unreadable }, FAMILY), {
    tokens: encode('abcd').length,
    unknownMedia: 2,
  });
  assertEquals(
    await resolveHistoryTokens({ history: [{ role: 'user', parts: [hdImage()] }] }, undefined),
    {
      tokens: 0,
      unknownMedia: 1,
    },
  );
});

Deno.test('resolveHistoryTokens: historyTokens 0 wins over a large estimate', async () => {
  assertEquals(
    await resolveHistoryTokens(
      { historyTokens: 0, history: [msg('user', 'x'.repeat(8000))] },
      FAMILY,
    ),
    { tokens: 0, unknownMedia: 0 },
  );
});

Deno.test('resolveHistoryTokens: inputTokens does not suppress a large estimate', async () => {
  const history = [msg('user', 'abcdefgh')];
  assertEquals(await resolveHistoryTokens({ inputTokens: 1, history }, FAMILY), {
    tokens: encode('abcdefgh').length,
    unknownMedia: 0,
  });
});

Deno.test('public barrel re-exports compaction helpers', () => {
  assertEquals(publicCompactionNeeded, compactionNeeded);
  assertEquals(publicResolveHistoryTokens, resolveHistoryTokens);
  assertEquals(publicResolveCompactionTokens, resolveCompactionTokens);
  assertEquals(publicCompactionMeter, compactionMeter);
  assertEquals(publicSplitForCompaction, splitForCompaction);
  assertEquals(compactionMeter(DEFAULT_SPEC), 'history');
});

Deno.test('sanitizeTurnRequest preserves historyTokens and inputTokens', () => {
  const speaker = registerCompactionPair('compaction.sanitize.tokens', ORCHID_SPEC);
  const safe = sanitizeTurnRequest(
    {
      profile: speaker,
      input: {
        text: 'hi',
        historyTokens: 1501,
        inputTokens: 99_999,
        history: SMALL_HISTORY,
      },
    },
    getProfile(speaker),
  );
  assertEquals(safe.input.historyTokens, 1501);
  assertEquals(safe.input.inputTokens, 99_999);
});

Deno.test('orchid after: history images count by the model rule, not payload size', async () => {
  const speaker = registerCompactionPair('compaction.orchid.image', ORCHID_SPEC);
  const oneImage: TurnHistoryMessage[] = [
    { role: 'user', parts: [hdImage()] },
    msg('assistant', 'ok'),
  ];
  const twoImages: TurnHistoryMessage[] = [
    { role: 'user', parts: [hdImage(), hdImage()] },
    msg('assistant', 'ok'),
  ];
  const oneEvents = await collectEvents(
    speaker,
    { text: 'q', history: oneImage },
    tokenProvider(12),
  );
  const twoEvents = await collectEvents(
    speaker,
    { text: 'q', history: twoImages },
    tokenProvider(12),
  );
  assertEquals(firstOf(oneEvents, 'done')?.compaction, undefined);
  const signal = firstOf(twoEvents, 'done')?.compaction;
  assertEquals(signal?.needed, true);
  assertEquals(signal?.tokens, (await resolveHistoryTokens({ history: twoImages }, FAMILY)).tokens);
  assertEquals(signal?.tokens !== undefined && signal.tokens > 2 * HD_IMAGE_TOKENS, true);
  assertEquals(signal?.unknownMedia, 0);
});

Deno.test('orchid after: API prompt tokens over 1500 with short history do not fire', async () => {
  const speaker = registerCompactionPair('compaction.orchid.api', ORCHID_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'question', inputTokens: 50_000, history: SMALL_HISTORY },
    tokenProvider(50_000),
  );
  assertEquals(firstOf(events, 'done')?.compaction, undefined);
  assertEquals(firstOf(events, 'tokens')?.tokens?.input, 50_000);
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
  assertEquals(firstOf(overEvents, 'done')?.compaction?.needed, true);
  assertEquals(firstOf(overEvents, 'done')?.compaction?.tokens, 1501);
  assertEquals(firstOf(overEvents, 'done')?.compaction?.promptTokens, 12);
  assertEquals(firstOf(exactEvents, 'done')?.compaction, undefined);
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
  assertEquals(firstOf(events, 'done')?.compaction, undefined);
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
  assertEquals(firstOf(events, 'done')?.compaction, undefined);
});

Deno.test('orchid after: inputTokens under threshold does not hide a large history estimate', async () => {
  const speaker = registerCompactionPair('compaction.orchid.estimate_vs_last', ORCHID_SPEC);
  const longHistory = [...exchange(bulky(), bulky())];
  const events = await collectEvents(
    speaker,
    { text: 'q', inputTokens: 1, history: longHistory },
    tokenProvider(1),
  );
  const done = firstOf(events, 'done');
  assertEquals(done?.compaction?.needed, true);
  assertEquals(
    done?.compaction?.tokens,
    (await resolveHistoryTokens({ history: longHistory }, FAMILY)).tokens,
  );
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
          yield { type: 'done' as const, stop: { kind: 'completed' } };
        })(),
    },
  )) {
    events.push(ev);
  }

  const tokensEvent = firstOf(events, 'tokens');
  const doneEvent = firstOf(events, 'done');
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
  const signal = firstOf(events, 'done')?.compaction;
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
  const { toCompact, toRetain } = await splitForCompaction(history, spec, FAMILY);
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
  const signal = firstOf(events, 'done')?.compaction;
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
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
    eventsOf(events, 'text').map((e) => e.text),
    ['ok'],
  );
});

const INPUT_AFTER_SPEC = {
  maxTokens: 1000,
  compactAt: 0.5,
  previousExchanges: 2,
  timing: 'after' as const,
  meter: 'input' as const,
};
const INPUT_BEFORE_SPEC = { ...INPUT_AFTER_SPEC, timing: 'before' as const };

Deno.test('resolveCompactionTokens input meter prefers the last call then host inputTokens', async () => {
  const spec: CompactionSpec = { ...INPUT_AFTER_SPEC, profile: 'x' };
  assertEquals(
    await resolveCompactionTokens({
      spec,
      input: { inputTokens: 100 },
      prompt: { input: 900, output: 10, total: 910 },
      family: FAMILY,
    }),
    { meter: 'input', tokens: 900, unknownMedia: 0 },
  );
  assertEquals(
    await resolveCompactionTokens({
      spec,
      input: { inputTokens: 100 },
      prompt: {
        input: 900,
        output: 10,
        total: 910,
        estimated: ['input', 'output'],
        unknownMedia: { input: 2, output: 1 },
      },
      family: FAMILY,
    }),
    { meter: 'input', tokens: 900, unknownMedia: 2 },
  );
  assertEquals(
    await resolveCompactionTokens({ spec, input: { inputTokens: 100 }, family: FAMILY }),
    {
      meter: 'input',
      tokens: 100,
      unknownMedia: 0,
    },
  );
  assertEquals(await resolveCompactionTokens({ spec, input: {}, family: FAMILY }), undefined);
  assertEquals(
    await resolveCompactionTokens({
      spec: { ...DEFAULT_SPEC, meter: 'history' },
      input: { history: [msg('user', 'abcd')], inputTokens: 50_000 },
      family: FAMILY,
    }),
    { meter: 'history', tokens: encode('abcd').length, unknownMedia: 0 },
  );
});

Deno.test('shouldCompact uses default threshold when trigger is omitted', async () => {
  assertEquals(
    await shouldCompact({ meter: 'history', unknownMedia: 0, tokens: 80_000 }, DEFAULT_SPEC),
    true,
  );
  assertEquals(
    await shouldCompact({ meter: 'history', unknownMedia: 0, tokens: 50_000 }, DEFAULT_SPEC),
    false,
  );
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
  assertEquals(
    await shouldCompact({ meter: 'history', unknownMedia: 0, tokens: 99_999 }, forcedOff),
    false,
  );
  assertEquals(
    await shouldCompact({ meter: 'history', unknownMedia: 0, tokens: 11 }, forcedOn),
    true,
  );
  assertEquals(
    await shouldCompact({ meter: 'history', unknownMedia: 0, tokens: 5 }, forcedOn),
    false,
  );
});

Deno.test('shouldCompact awaits async trigger', async () => {
  const spec: CompactionSpec = {
    ...DEFAULT_SPEC,
    trigger: async (ctx) => {
      await Promise.resolve();
      return ctx.meter === 'input' && ctx.tokens > ctx.compactAt * ctx.maxTokens;
    },
  };
  assertEquals(
    await shouldCompact({ meter: 'input', unknownMedia: 0, tokens: 80_000 }, spec),
    true,
  );
});

Deno.test('resolveHistoryTokens media-only history does not require host historyTokens', async () => {
  assertEquals(
    await resolveHistoryTokens({ history: [{ role: 'user', parts: [hdImage()] }] }, FAMILY),
    {
      tokens: HD_IMAGE_TOKENS,
      unknownMedia: 0,
    },
  );
});

Deno.test('meter input after fires from provider tokens.input', async () => {
  const speaker = registerCompactionPair('compaction.input.after', INPUT_AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'q', history: SMALL_HISTORY },
    tokenProvider(800),
  );
  const done = firstOf(events, 'done');
  assertEquals(done?.compaction?.needed, true);
  assertEquals(done?.compaction?.meter, 'input');
  assertEquals(done?.compaction?.tokens, 800);
  assertEquals(done?.compaction?.promptTokens, 800);
  assertEquals(done?.compaction?.promptTokensEstimated, undefined);
});

Deno.test('meter input after fires from the estimate when the provider reports no usage', async () => {
  const speaker = registerCompactionPair('compaction.input.after.estimated', INPUT_AFTER_SPEC);
  const history = exchange(bulky(), 'ok');
  const provider: ModelProvider = {
    complete: () =>
      (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
  const events = await collectEvents(speaker, { text: 'q', history }, provider);
  const tokens = firstOf(events, 'tokens')?.tokens;
  const signal = firstOf(events, 'done')?.compaction;
  assertEquals(tokens?.estimated, ['input', 'output']);
  assertEquals(signal?.needed, true);
  assertEquals(signal?.tokens, tokens?.input);
  assertEquals(signal?.promptTokens, tokens?.input);
  assertEquals(signal?.promptTokensEstimated, true);
  assertEquals((tokens?.input ?? 0) > encode(bulky()).length, true);
});

Deno.test('meter input after does not fire when provider tokens are under threshold', async () => {
  const speaker = registerCompactionPair('compaction.input.after.under', INPUT_AFTER_SPEC);
  const events = await collectEvents(
    speaker,
    { text: 'q', history: SMALL_HISTORY, historyTokens: 50_000 },
    tokenProvider(100),
  );
  assertEquals(firstOf(events, 'done')?.compaction, undefined);
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
          yield { type: 'done' as const, stop: { kind: 'completed' } };
        })();
      }
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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

catalogGate();

const png = { type: 'image' as const, mimeType: 'image/png', data: bytesToBase64(pngBytes(8, 8)) };
const TOOL_HISTORY: TurnHistoryMessage[] = [
  { role: 'user', content: 'what is this?', parts: [png] },
  {
    role: 'assistant',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cat"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'c1', content: '{"found":"a cat"}' },
  msg('assistant', 'It is a cat.'),
];

Deno.test('the compactor reads tool calls and results as text naming the tool', () => {
  registerCompactionPair('compaction.reader.text', BEFORE_SPEC);
  assertEquals(compactorHistory(TOOL_HISTORY, getProfile('compaction.reader.text.compactor')), {
    history: [
      { role: 'user', content: 'what is this?' },
      { role: 'assistant', parts: [{ type: 'text', text: 'Called lookup with {"q":"cat"}' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'lookup returned: {"found":"a cat"}' }] },
      msg('assistant', 'It is a cat.'),
    ],
    droppedMedia: 1,
  });
});

Deno.test('the compactor keeps media it accepts', () => {
  registerCompactionPair('compaction.reader.media', BEFORE_SPEC, {
    inputs: {
      text: true,
      attachments: { accept: ['image/png'] },
      maxFiles: 5,
      maxBytes: 1_000_000,
      maxTurnBytes: 5_000_000,
    },
  });
  const { history, droppedMedia } = compactorHistory(
    TOOL_HISTORY,
    getProfile('compaction.reader.media.compactor'),
  );
  assertEquals(history[0], { role: 'user', content: 'what is this?', parts: [png] });
  assertEquals(droppedMedia, 0);
});

Deno.test('a message with nothing the compactor can read is left out', () => {
  registerCompactionPair('compaction.reader.empty', BEFORE_SPEC);
  assertEquals(
    compactorHistory(
      [{ role: 'user', parts: [png] }, msg('assistant', 'ok')],
      getProfile('compaction.reader.empty.compactor'),
    ),
    { history: [msg('assistant', 'ok')], droppedMedia: 1 },
  );
});

function compactorScript(
  compactor: () => AsyncGenerator<ProviderEvent>,
  seen: ProviderCompleteRequest[] = [],
): ModelProvider {
  return {
    complete: (req) => {
      seen.push(req);
      if (seen.length === 1) return compactor();
      return (async function* () {
        yield { type: 'text' as const, text: 'response' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })();
    },
  };
}

function compactorSays(...events: ProviderEvent[]): () => AsyncGenerator<ProviderEvent> {
  return async function* () {
    for (const event of events) yield event;
  };
}

const OLD = [...exchange('old 1', 'answer 1'), ...exchange('old 2', 'answer 2')];
const RECENT = [
  ...exchange('recent 1', 'recent answer 1'),
  ...exchange('recent 2', 'recent answer 2'),
];

async function compactBefore(
  prefix: string,
  compactor: () => AsyncGenerator<ProviderEvent>,
  input: TurnInput,
): Promise<{
  events: TurnEvent[];
  compaction: TurnEvent & { type: 'compaction' };
  seen: ProviderCompleteRequest[];
}> {
  const speaker = registerCompactionPair(prefix, BEFORE_SPEC);
  const seen: ProviderCompleteRequest[] = [];
  const events = await collectEvents(speaker, input, compactorScript(compactor, seen));
  const compaction = firstOf(events, 'compaction');
  if (!compaction) throw new Error('no compaction event');
  return { events, compaction, seen };
}

Deno.test('the compactor gets the compacted messages and a request to summarize them', async () => {
  const { compaction, seen } = await compactBefore(
    'compaction.real.messages',
    compactorSays({ type: 'text', text: 'Summary' }, { type: 'done', stop: { kind: 'completed' } }),
    { text: 'new question', historyTokens: 600, history: [...OLD, ...RECENT] },
  );
  assertEquals(
    seen[0]?.history?.map((m) => [m.role, m.content]),
    [
      ...OLD.map((m) => [m.role, m.content]),
      [
        'user',
        '<user_data>\nSummarize the conversation above, including any earlier summary in it. Reply with the summary only.\n</user_data>',
      ],
    ],
  );
  const summary = {
    role: 'assistant' as const,
    content: 'Summary',
    metadata: { compactionSummary: true },
  };
  assertEquals(compaction.outcome, 'compacted');
  assertEquals(compaction.summary, 'Summary');
  assertEquals(compaction.history, [summary, ...RECENT]);
  assertEquals(
    seen[1]?.history?.slice(0, -1).map((m) => [m.role, m.content]),
    [summary, ...RECENT].map((m) => [m.role, m.content]),
  );
});

Deno.test('a compactor cut off keeps the history whole when it still fits', async () => {
  const history = [...OLD, ...RECENT];
  const { compaction, seen } = await compactBefore(
    'compaction.fail.cutoff',
    compactorSays({ type: 'text', text: 'partial su' }, { type: 'done', stop: { kind: 'length' } }),
    { text: 'q', historyTokens: 600, history },
  );
  assertEquals(compaction.outcome, 'deferred');
  assertEquals(compaction.failure, { stop: 'length' });
  assertEquals(compaction.summary, undefined);
  assertEquals(compaction.history, history);
  assertEquals(
    seen[1]?.history?.slice(0, -1).map((m) => m.content),
    history.map((m) => m.content),
  );
});

Deno.test('a compactor that says nothing is a failure, not an empty summary', async () => {
  const history = [...OLD, ...RECENT];
  const { compaction } = await compactBefore(
    'compaction.fail.empty',
    compactorSays({ type: 'done', stop: { kind: 'completed' } }),
    { text: 'q', historyTokens: 600, history },
  );
  assertEquals(compaction.outcome, 'deferred');
  assertEquals(compaction.failure, { stop: 'completed', empty: true });
  assertEquals(compaction.history, history);
});

Deno.test('a compactor left nothing it can read does not run', async () => {
  const history: TurnHistoryMessage[] = [{ role: 'user', parts: [hdImage()] }, ...RECENT];
  const { compaction, seen } = await compactBefore(
    'compaction.fail.unreadable',
    compactorSays(
      { type: 'text', text: 'Nothing here' },
      { type: 'done', stop: { kind: 'completed' } },
    ),
    { text: 'q', historyTokens: 600, history },
  );
  assertEquals(compaction.outcome, 'deferred');
  assertEquals(compaction.failure, { unreadable: true });
  assertEquals(compaction.droppedMedia, 1);
  assertEquals(compaction.history, history);
  assertEquals(seen.length, 1);
});

Deno.test('a compactor that throws is a failure with its error kind', async () => {
  const history = [...OLD, ...RECENT];
  const { compaction, events } = await compactBefore(
    'compaction.fail.throw',
    async function* () {
      yield { type: 'text', text: 'partial' };
      throw new TheoremError('unavailable', 'down');
    },
    { text: 'q', historyTokens: 600, history },
  );
  assertEquals(compaction.outcome, 'deferred');
  assertEquals(compaction.failure?.error, 'unavailable');
  assertEquals(compaction.history, history);
  assertEquals(
    eventsOf(events, 'text').map((e) => e.text),
    ['response'],
  );
});

for (const kind of ['config', 'request', 'auth', 'internal'] as const) {
  Deno.test(`a compactor that throws ${kind} throws before the turn's model call`, async () => {
    const speaker = registerCompactionPair(`compaction.throws.${kind}`, BEFORE_SPEC);
    const seen: ProviderCompleteRequest[] = [];
    const provider = compactorScript(async function* () {
      yield { type: 'text', text: 'partial' };
      throw new TheoremError(kind, 'set up wrong');
    }, seen);
    await assertRejects(
      () =>
        collectEvents(
          speaker,
          { text: 'q', historyTokens: 600, history: [...OLD, ...RECENT] },
          provider,
        ),
      TheoremError,
      'set up wrong',
    );
    assertEquals(seen.length, 1);
  });

  Deno.test(`a compactor that reports ${kind} throws it`, async () => {
    const speaker = registerCompactionPair(`compaction.reports.${kind}`, BEFORE_SPEC);
    const seen: ProviderCompleteRequest[] = [];
    const provider = compactorScript(
      compactorSays(
        { type: 'error', errorKind: kind, error: 'Sorry.', errorInternal: 'no key in slot' },
        { type: 'done', stop: { kind: 'provider_error' } },
      ),
      seen,
    );
    const error = await assertRejects(
      () =>
        collectEvents(
          speaker,
          { text: 'q', historyTokens: 600, history: [...OLD, ...RECENT] },
          provider,
        ),
      TheoremError,
      `Compactor 'compaction.reports.${kind}.compactor' failed: no key in slot`,
    );
    assertEquals(error.kind, kind);
    assertEquals(seen.length, 1);
  });
}

Deno.test('compactHistory throws what the host must fix', async () => {
  const speaker = registerCompactionPair('compaction.export.throws', AFTER_SPEC);
  await assertRejects(
    () =>
      compactHistory(
        { profile: speaker, history: [...OLD, ...RECENT], tokens: 800 },
        {
          complete: () =>
            compactorSays(
              { type: 'error', errorKind: 'auth', error: 'Sorry.', errorInternal: 'rejected key' },
              { type: 'done', stop: { kind: 'provider_error' } },
            )(),
        },
      ),
    TheoremError,
    'rejected key',
  );
});

Deno.test('a failed compaction over maxTokens drops the compacted messages but keeps an earlier summary', async () => {
  const earlier: TurnHistoryMessage = {
    role: 'assistant',
    content: 'Earlier summary',
    metadata: { compactionSummary: true },
  };
  const { compaction, seen } = await compactBefore(
    'compaction.fail.dropped',
    compactorSays({ type: 'done', stop: { kind: 'provider_error' } }),
    { text: 'q', historyTokens: 1200, history: [earlier, ...OLD, ...RECENT] },
  );
  assertEquals(compaction.outcome, 'dropped');
  assertEquals(compaction.failure, { stop: 'provider_error' });
  assertEquals(compaction.history, [earlier, ...RECENT]);
  assertEquals(
    seen[1]?.history?.slice(0, -1).map((m) => m.content),
    ['Earlier summary', ...RECENT.map((m) => m.content)],
  );
});

Deno.test('a failed compaction is recorded with how it failed', async () => {
  const speaker = registerCompactionPair('compaction.trace.failed', BEFORE_SPEC);
  const { record, decision } = await tracedTurn(
    speaker,
    { text: 'q', historyTokens: 600, history: [...OLD, ...RECENT] },
    compactorScript(compactorSays({ type: 'done', stop: { kind: 'length' } })),
  );
  assertEquals(decision, {
    timing: 'before',
    meter: 'history',
    budget: 1000,
    threshold: 0.5,
    tokens_before: 600,
    unknown_media: 0,
    needed: true,
    outcome: 'deferred',
    messages_before: 8,
    messages_after: 8,
    dropped_media: 0,
    failure_stop: 'length',
  });
  assertEquals(record.spans[0]?.attributes['gen_ai.conversation.compacted'], undefined);
});

Deno.test('the host aborting during compaction cancels the turn', async () => {
  const speaker = registerCompactionPair('compaction.abort', BEFORE_SPEC);
  const controller = new AbortController();
  const seen: ProviderCompleteRequest[] = [];
  const provider = compactorScript(async function* () {
    controller.abort();
    yield { type: 'text', text: 'x' };
    controller.signal.throwIfAborted();
  }, seen);
  const events: TurnEvent[] = [];
  for await (const ev of runTurn(
    {
      profile: speaker,
      input: { text: 'q', historyTokens: 600, history: [...OLD, ...RECENT] },
      signal: controller.signal,
    },
    provider,
  )) {
    events.push(ev);
  }
  assertEquals(seen.length, 1);
  assertEquals(firstOf(events, 'compaction'), undefined);
  assertEquals(firstOf(events, 'done')?.stop.kind, 'cancelled');
});

Deno.test('compactHistory runs the compactor on what done.compaction carried', async () => {
  const speaker = registerCompactionPair('compaction.export', AFTER_SPEC);
  const records: TraceRecord[] = [];
  const result = await compactHistory(
    { profile: speaker, history: [...OLD, ...RECENT], tokens: 800 },
    {
      complete: () =>
        compactorSays(
          { type: 'text', text: 'Summary' },
          { type: 'done', stop: { kind: 'completed' } },
        )(),
    },
    catalogedSink(records),
  );
  assertEquals(result?.outcome, 'compacted');
  assertEquals(result?.toCompact, OLD);
  assertEquals(
    result?.history.map((m) => m.content),
    ['Summary', ...RECENT.map((m) => m.content)],
  );
  const event = records[0]?.spans[0]?.events.find((e) => e.name === 'theorem.compaction');
  const { summary, ...rest } = event?.attributes ?? {};
  assertEquals(rest, {
    timing: 'after',
    meter: 'history',
    budget: 1000,
    threshold: 0.5,
    tokens_before: 800,
    outcome: 'compacted',
    messages_before: 8,
    messages_after: 5,
    dropped_media: 0,
  });
  assertEquals(contentOf(records[0] as TraceRecord, summary), 'Summary');
});

Deno.test('compactHistory has nothing to do when every message is retained', async () => {
  const speaker = registerCompactionPair('compaction.export.retained', AFTER_SPEC);
  assertEquals(
    await compactHistory({ profile: speaker, history: RECENT, tokens: 800 }, tokenProvider(0)),
    undefined,
  );
});

Deno.test('compactHistory needs a model with compaction', async () => {
  registerCompactionPair('compaction.export.none', AFTER_SPEC);
  await assertRejects(
    () =>
      compactHistory(
        { profile: 'compaction.export.none.compactor', history: OLD, tokens: 800 },
        tokenProvider(0),
      ),
    TheoremError,
    "model 'gemini35FlashLite' has no compaction",
  );
});

Deno.test('registerProfile rejects a compactor that is not a text profile', () => {
  registerProfile(
    defineProfile({
      id: 'compaction.validator.image_compactor',
      type: 'image',
      identity: { handle: 'image' },
      ...geminiModels('gemini31FlashLiteImage'),
      image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/jpeg' },
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  assertThrows(
    () =>
      registerCompactionPair('compaction.validator.image', {
        ...BEFORE_SPEC,
        profile: 'compaction.validator.image_compactor',
      }),
    TheoremError,
    "compaction profile 'compaction.validator.image_compactor' must be a text profile that takes text",
  );
});

Deno.test('a compactor on another provider needs compactionProvider', async () => {
  const speaker = registerCompactionPair('compaction.provider', BEFORE_SPEC, {
    models: { sonar: HOST_BINDINGS.sonar },
  });
  const turn = (compactionProvider?: ModelProvider) =>
    collectEventsFor({
      profile: speaker,
      input: { text: 'q', history: SMALL_HISTORY },
      ...(compactionProvider ? { compactionProvider } : {}),
    });
  await assertRejects(
    () => turn(),
    TheoremError,
    "Profile compaction.provider.speaker compacts with 'compaction.provider.compactor', which this turn's provider cannot run; pass compactionProvider",
  );
  assertEquals(
    eventsOf(await turn(tokenProvider(0)), 'text').map((e) => e.text),
    ['response'],
  );
});

async function collectEventsFor(req: Parameters<typeof runTurn>[0]): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of runTurn(req, tokenProvider(0))) events.push(ev);
  return events;
}

function registerSpeaker(id: string, type: 'image' | 'speech', compactor: string): string {
  const compaction = { ...BEFORE_SPEC, profile: compactor };
  registerProfile(
    type === 'speech'
      ? defineProfile({
          id,
          type,
          identity: { handle: 'speaker' },
          key: 'slotA',
          models: { tts: { ...HOST_BINDINGS.gemini31FlashTts, compaction } },
          speech: { voice: 'Kore', format: 'pcm' },
        })
      : defineProfile({
          id,
          type,
          identity: { handle: 'painter' },
          key: 'slotA',
          models: { img: { ...HOST_BINDINGS.gemini31FlashLiteImage, compaction } },
          image: { mimeType: 'image/jpeg' },
          tools: { allow: [] },
          inputs: { text: true },
        }),
  );
  return id;
}

for (const type of ['speech', 'image'] as const) {
  Deno.test(`a ${type} profile compacts before its turn on compactionProvider`, async () => {
    registerCompactionPair(`compaction.${type}`, BEFORE_SPEC);
    const speaker = registerSpeaker(
      `compaction.${type}.speaker`,
      type,
      `compaction.${type}.compactor`,
    );
    const compactorSeen: ProviderCompleteRequest[] = [];
    const speakerSeen: ProviderCompleteRequest[] = [];
    const events: TurnEvent[] = [];
    for await (const ev of runTurn(
      {
        profile: speaker,
        input: { text: 'say it', historyTokens: 600, history: [...OLD, ...RECENT] },
        compactionProvider: compactorScript(
          compactorSays(
            { type: 'text', text: 'Summary' },
            { type: 'done', stop: { kind: 'completed' } },
          ),
          compactorSeen,
        ),
      },
      {
        complete: (req) => {
          speakerSeen.push(req);
          return compactorSays({ type: 'done', stop: { kind: 'completed' } })();
        },
      },
    )) {
      events.push(ev);
    }
    assertEquals(compactorSeen.length, 1);
    assertEquals(firstOf(events, 'compaction')?.outcome, 'compacted');
    assertEquals(
      speakerSeen[0]?.history?.slice(0, 5).map((m) => m.content),
      ['Summary', ...RECENT.map((m) => m.content)],
    );
  });

  Deno.test(`a ${type} profile needs compactionProvider to compact`, async () => {
    registerCompactionPair(`compaction.${type}.bare`, BEFORE_SPEC);
    const speaker = registerSpeaker(
      `compaction.${type}.bare.speaker`,
      type,
      `compaction.${type}.bare.compactor`,
    );
    await assertRejects(
      () => collectEvents(speaker, { text: 'say it', history: SMALL_HISTORY }, tokenProvider(0)),
      TheoremError,
      'pass compactionProvider',
    );
  });
}
