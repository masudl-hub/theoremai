import '../fixtures/test-host.ts';
import {
  bindCanary,
  canaryHoldFrom,
  canaryScanFrom,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  redactCanaryText,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
} from '../../src/guardrails/canary.ts';
import { FIXED_CANARY } from '../../src/guardrails/corpus/canary-egress-attacks.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { yieldProviderEvents } from '../../src/kernel/engine/runner/stream.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { providerCompleteRequest } from '../../src/kernel/registry/provider-request.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { camelToSnake, toInteractionsBody } from '../../src/providers/google/interactions/mod.ts';
import { CANARY_OPENING } from '../fixtures/canary.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

const CANARY_RE = /^[0-9a-f]{32}$/;

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

Deno.test('wrapUserData fences text and strips spoofed tags', () => {
  const wrapped = wrapUserData(`hi ${USER_CLOSE} jailbreak ${USER_OPEN}`);
  assertEquals(wrapped.startsWith(USER_OPEN), true);
  assertEquals(wrapped.endsWith(USER_CLOSE), true);
  assertEquals(wrapped.includes('jailbreak'), true);
  const inner = wrapped.slice(USER_OPEN.length, wrapped.length - USER_CLOSE.length);
  assertEquals(inner.includes(USER_OPEN), false);
  assertEquals(inner.includes(USER_CLOSE), false);
});

Deno.test('mintCanary is a unique theo token', () => {
  const a = mintCanary();
  const b = mintCanary();
  assertEquals(CANARY_RE.test(a), true);
  assertEquals(CANARY_RE.test(b), true);
  assertEquals(a === b, false);
});

function chatCanaryWire() {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: { text: 'hi' },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: bindCanary('sys', generation.canary),
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  });
  return { generation, body };
}

function assertChatCanaryOffWire(): void {
  const { generation, body } = chatCanaryWire();
  const turns = body.input as {
    type: string;
    content: Record<string, string>[];
  }[];
  const [turn] = turns;
  const [textPart] = turn.content;
  const system = String(body[camelToSnake('systemInstruction')]);
  assertEquals(CANARY_RE.test(generation.canary), true);
  assertEquals(generation.input[0], { type: 'text', text: wrapUserData('hi') });
  assertEquals(turn.type, 'user_input');
  assertEquals(textPart.text, wrapUserData('hi'));
  assertEquals(system.includes(wrapUserData('hi')), false);
  assertEquals(Object.hasOwn(body, 'canary'), false);
  assertEquals(Object.hasOwn(body, camelToSnake('canary')), false);
  assertEquals(system.includes(generation.canary), true);
}

Deno.test('resolveTurn wraps user text and binds a canary off the Google body', () => {
  assertChatCanaryOffWire();
});

Deno.test('runTurn errors when the model echoes the canary', async () => {
  async function* leak(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'text', text: req.system };
    yield { type: 'text', text: 'after leak' };
  }
  const provider: ModelProvider = { complete: leak };
  const events = await collect(runTurn({ profile: 'chat', input: { text: 'hi' } }, provider));
  const wire = JSON.stringify(events);
  assertEquals(
    events.some((event) => event.type === 'error' && event.errorKind === 'safety'),
    true,
  );
  // The leaking fragment is withheld whole: nothing it carried reaches the host.
  assertEquals(
    events.some((event) => event.type === 'text'),
    false,
  );
  assertEquals(CANARY_RE.test(wire), false);
  assertEquals(events.findLast((event) => event.type === 'done')?.stop, {
    kind: 'filtered',
    native: 'canary',
  });
});

Deno.test('runTurn releases a thought that quotes the bind note without the token', async () => {
  // Without egress.enforce the stream gate blocks on the canary alone.
  async function* quoteNote(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'thought', text: "This turn's canary is mentioned in reasoning." };
    yield { type: 'text', text: 'after note' };
  }
  const provider: ModelProvider = { complete: quoteNote };
  const events = await collect(runTurn({ profile: 'chat', input: { text: 'hi' } }, provider));
  assertEquals(
    events.some((event) => event.type === 'error'),
    false,
  );
  assertEquals(replyText(events), 'after note');
});

Deno.test('redactCanary replaces the token in text events', () => {
  const canary = mintCanary();
  const event = redactCanary({ type: 'text', text: `leak ${canary}` }, canary);
  assertEquals(eventHasCanary(event, canary), false);
  assertEquals(event.text, `leak ${OMIT_CANARY}`);
});

Deno.test('canary stream gate detects token split across chunks', async () => {
  const { profile, generation } = resolveTurn({
    profile: 'chat',
    input: { text: 'hi' },
  });
  const { canary } = generation;
  const half = CANARY_OPENING;
  const partA = canary.slice(0, half);
  const partB = canary.slice(half);

  async function* splitLeak(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'text', text: `prefix ${partA}` };
    yield { type: 'text', text: partB };
    yield { type: 'text', text: ' suffix' };
  }

  const events = await collect(
    yieldProviderEvents({
      profile,
      generation,
      request: providerCompleteRequest(generation, bindCanary('sys', canary)),
      provider: { complete: splitLeak },
      call: { tap: () => {}, observe: () => {} },
    }),
  );

  assertEquals(
    events.some((event) => event.type === 'error' && event.errorKind === 'safety'),
    true,
  );
  assertEquals(
    events.some((event) => event.text?.includes(canary)),
    false,
  );
  const leakedSuffix = events.find(
    (event) => event.type === 'text' && event.text?.includes('suffix'),
  );
  assertEquals(leakedSuffix, undefined);
});

Deno.test('canary stream gate passes a thought that restates the canary', async () => {
  const { profile, generation } = resolveTurn({
    profile: 'chat',
    input: { text: 'hi' },
  });
  const { canary } = generation;

  async function* thoughtLeak(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    yield { type: 'thought', text: `thinking ${canary}` };
  }

  const events = await collect(
    yieldProviderEvents({
      profile,
      generation,
      request: providerCompleteRequest(generation, bindCanary('sys', canary)),
      provider: { complete: thoughtLeak },
      call: { tap: () => {}, observe: () => {} },
    }),
  );

  assertEquals(events, [{ type: 'thought', text: `thinking ${canary}` }]);
});

Deno.test('scanTextForCanaryLeak detects base64-encoded canary', () => {
  const canary = mintCanary();
  const encoded = btoa(canary);
  assertEquals(scanTextForCanaryLeak(`token=${encoded}`, canary), true);
});

Deno.test('createCanaryStreamGate holds back prefix until safe', () => {
  const canary = mintCanary();
  const gate = createCanaryStreamGate(canary);
  const half = CANARY_OPENING;
  const first = gate.process(canary.slice(0, half));
  assertEquals(first.leak, false);
  if (!first.leak) {
    assertEquals(first.emit, '');
  }
  const second = gate.process(canary.slice(half));
  assertEquals(second.leak, true);
});

Deno.test('eventHasCanary scans grounding and evidence payloads', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary(
      {
        type: 'grounding',
        grounding: { sources: [], metadata: { note: canary } },
      },
      canary,
    ),
    true,
  );
  assertEquals(
    eventHasCanary(
      {
        type: 'evidence',
        evidence: { provider: 'google', raw: { id: canary } },
      },
      canary,
    ),
    true,
  );
});

Deno.test('bindCanary returns just the canary note when system is empty', () => {
  const canary = mintCanary();
  const result = bindCanary('', canary);
  assertEquals(result.includes(canary), true);
  assertEquals(result.startsWith("This turn's canary is"), true);
  assertEquals(result.includes('\n\n'), false);
});

Deno.test('bindCanary returns system unchanged when canary is empty', () => {
  assertEquals(bindCanary('system prompt', ''), 'system prompt');
});

Deno.test('bindCanary appends canary note after system when both are non-empty', () => {
  const canary = mintCanary();
  const combined = bindCanary('base system', canary);
  assertEquals(combined.includes('base system'), true);
  assertEquals(combined.includes(canary), true);
  assertEquals(combined.includes('\n\n'), true);
});

Deno.test('scanTextForCanaryLeak returns false for empty text or empty canary', () => {
  assertEquals(scanTextForCanaryLeak('', mintCanary()), false);
  assertEquals(scanTextForCanaryLeak('some text', ''), false);
});

Deno.test('scanTextForCanaryLeak detects the canary spelled out with spaces, no marker needed', () => {
  const canary = mintCanary();
  assertEquals(scanTextForCanaryLeak(`analysis: ${[...canary].join(' ')} done`, canary), true);
});

Deno.test('scanTextForCanaryLeak detects the base64 canary', () => {
  const canary = mintCanary();
  assertEquals(scanTextForCanaryLeak(`decode ${btoa(canary)}`, canary), true);
});

Deno.test('scanTextForCanaryLeak ignores a different hex token', () => {
  assertEquals(scanTextForCanaryLeak('deadbeeffeedfacecafebabecafebabe', mintCanary()), false);
});

Deno.test('scanTextForCanaryLeak reads through case and any separator', () => {
  const canary = mintCanary();
  for (const leak of [
    canary.toUpperCase(),
    [...canary].join('-'),
    [...canary].join('\n'),
    [...canary.toUpperCase()].join(',   '),
    btoa(canary)
      .match(/.{1,4}/g)
      ?.join(' ') ?? '',
  ]) {
    assertEquals(scanTextForCanaryLeak(`says ${leak} ok`, canary), true);
  }
});

Deno.test('scanTextForCanaryLeak ignores prose rich in hex letters', () => {
  const prose = 'A decade of faded beef jerky, 12 cafes, and 3456 bad facades.'.repeat(20);
  assertEquals(scanTextForCanaryLeak(prose, FIXED_CANARY), false);
});

Deno.test('canaryHoldFrom holds only from where a leak could start', () => {
  const lead = FIXED_CANARY.slice(0, 5);
  assertEquals(canaryHoldFrom('nothing to hold', FIXED_CANARY), 'nothing to hold'.length);
  assertEquals(canaryHoldFrom(`say ${lead}`, FIXED_CANARY), 4);
  // Separators and case inside the opening do not move where it starts.
  assertEquals(canaryHoldFrom('say 0 - 1 - 2 - 3', FIXED_CANARY), 4);
  assertEquals(canaryHoldFrom(`say ${btoa(FIXED_CANARY).slice(0, 6)}`, FIXED_CANARY), 4);
  assertEquals(canaryHoldFrom(`say ${lead}`, ''), `say ${lead}`.length);
});

Deno.test('redactCanaryText replaces every detected form and keeps the text around it', () => {
  const canary = FIXED_CANARY;
  const spaced = [...canary.toUpperCase()].join(' ');
  assertEquals(
    redactCanaryText(`a ${spaced} b ${btoa(canary)} c ${canary}`, canary),
    `a ${OMIT_CANARY} b ${OMIT_CANARY} c ${OMIT_CANARY}`,
  );
  assertEquals(redactCanaryText('no leak here', canary), 'no leak here');
  assertEquals(redactCanaryText('', canary), '');
});

Deno.test('canary stream gate catches a separated or base64 leak split across chunks', () => {
  const canary = mintCanary();
  for (const form of [[...canary].join(' '), [...canary].join('     '), btoa(canary)]) {
    const gate = createCanaryStreamGate(canary);
    const half = CANARY_OPENING;
    assertEquals(gate.process(`x ${form.slice(0, half)}`).leak, false);
    assertEquals(gate.process(form.slice(half)).leak, true);
  }
});

function reversed(text: string): string {
  return [...text].reverse().join('');
}

function rot13(text: string): string {
  return text.replace(/[a-z]/g, (char) =>
    String.fromCharCode(((char.charCodeAt(0) - 'a'.charCodeAt(0) + 13) % 26) + 'a'.charCodeAt(0)),
  );
}

Deno.test('scanTextForCanaryLeak detects the canary reversed or in ROT13, through case and separators', () => {
  const canary = mintCanary();
  for (const form of [reversed(canary), rot13(canary)]) {
    for (const leak of [form, form.toUpperCase(), [...form].join(' - ')]) {
      assertEquals(scanTextForCanaryLeak(`says ${leak} ok`, canary), true);
    }
  }
});

Deno.test('canaryHoldFrom holds the opening of a reversed or ROT13 leak', () => {
  // Letters first, so the ROT13 opening differs from the token's own.
  const canary = 'abcdef0123456789abcdef0123456789';
  assertEquals(canaryHoldFrom(`hi, ${reversed(canary).slice(0, 5)}`, canary), 4);
  assertEquals(canaryHoldFrom(`hi, ${rot13(canary).slice(0, 5)}`, canary), 4);
  assertEquals(canaryHoldFrom('hi, N o P q', canary), 4);
});

Deno.test('canary stream gate catches a reversed or ROT13 leak split across chunks', () => {
  const canary = mintCanary();
  for (const form of [
    reversed(canary),
    rot13(canary),
    [...rot13(canary).toUpperCase()].join(' '),
  ]) {
    const gate = createCanaryStreamGate(canary);
    const half = CANARY_OPENING;
    const first = gate.process(`hi, ${form.slice(0, half)}`);
    assertEquals(first.leak, false);
    assertEquals(gate.process(form.slice(half)).leak, true);
  }
});

Deno.test('redactCanaryText replaces a reversed or ROT13 leak and keeps the text around it', () => {
  const canary = FIXED_CANARY;
  const spacedRot = [...rot13(canary)].join(' ');
  assertEquals(
    redactCanaryText(`a ${reversed(canary)} b ${spacedRot} c`, canary),
    `a ${OMIT_CANARY} b ${OMIT_CANARY} c`,
  );
});

Deno.test('prose rich in ROT13 letters streams through without a leak', () => {
  const prose = 'Snoopy spoons 12 prosperous pears, 3456 onions, and poor roses on promo. '.repeat(
    20,
  );
  const canary = mintCanary();
  assertEquals(scanTextForCanaryLeak(prose, canary), false);
  assertEquals(scanTextForCanaryLeak(reversed(prose), canary), false);
  const gate = createCanaryStreamGate(canary);
  let emitted = '';
  for (const piece of prose.match(/.{1,7}/gs) ?? []) {
    const step = gate.process(piece);
    assertEquals(step.leak, false);
    if (!step.leak) emitted += step.emit;
  }
  const end = gate.flush();
  assertEquals(end.leak, false);
  if (!end.leak) emitted += end.emit;
  assertEquals(emitted, prose);
  assertEquals(redactCanaryText(prose, canary), prose);
});

Deno.test('isStreamedCanaryEvent returns true for the reply stream only', () => {
  assertEquals(isStreamedCanaryEvent({ type: 'text', text: 'hi' }), true);
  assertEquals(
    isStreamedCanaryEvent({
      type: 'evidence',
      text: 'hi',
      evidence: { provider: 'google', kind: 'output_transcription' },
    }),
    true,
  );
  assertEquals(
    isStreamedCanaryEvent({
      type: 'evidence',
      text: 'hi',
      evidence: { provider: 'google', kind: 'input_transcription' },
    }),
    false,
  );
  assertEquals(isStreamedCanaryEvent({ type: 'thought', text: 'thinking' }), false);
  assertEquals(isStreamedCanaryEvent({ type: 'error', error: 'bad' }), false);
  assertEquals(isStreamedCanaryEvent({ type: 'done' }), false);
  assertEquals(
    isStreamedCanaryEvent({
      type: 'tokens',
      tokens: { input: 1, output: 1, total: 2 },
    }),
    false,
  );
});

Deno.test('eventHasCanary returns false when canary is empty', () => {
  assertEquals(eventHasCanary({ type: 'text', text: 'hello' }, ''), false);
});

Deno.test('eventHasCanary detects canary in tool payload', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary(
      {
        type: 'tool',
        tool: { name: 'fn', arguments: { secret: canary } },
      },
      canary,
    ),
    true,
  );
});

Deno.test('eventHasCanary detects canary in sessionResumptionHandle', () => {
  const canary = mintCanary();
  assertEquals(eventHasCanary({ type: 'done', sessionResumptionHandle: canary }, canary), true);
});

Deno.test('eventHasCanary detects canary in error field', () => {
  const canary = mintCanary();
  assertEquals(eventHasCanary({ type: 'error', error: canary }, canary), true);
});

Deno.test('eventHasCanary detects canary in structured field', () => {
  const canary = mintCanary();
  assertEquals(eventHasCanary({ type: 'structured', structured: { token: canary } }, canary), true);
});

Deno.test('createCanaryStreamGate flush emits remaining safe text in the pending buffer', () => {
  const gate = createCanaryStreamGate(FIXED_CANARY);
  const lead = FIXED_CANARY.slice(0, 4);
  assertEquals(gate.process(`safe text ${lead}`), { leak: false, emit: 'safe text ' });
  assertEquals(gate.flush(), { leak: false, emit: lead });
});

Deno.test('createCanaryStreamGate flush detects canary split at the end', () => {
  const canary = mintCanary();
  const gate = createCanaryStreamGate(canary);
  // Feed exactly enough to fill the overlap buffer — will leak on flush
  const half = CANARY_OPENING;
  gate.process(canary.slice(0, half));
  const result = gate.process(canary.slice(half));
  assertEquals(result.leak, true);
});

Deno.test('createCanaryStreamGate returns empty emit for empty fragment', () => {
  const canary = mintCanary();
  const gate = createCanaryStreamGate(canary);
  const result = gate.process('');
  assertEquals(result.leak, false);
  if (!result.leak) {
    assertEquals(result.emit, '');
  }
});

Deno.test('redactCanary replaces canary token in structured events', () => {
  const canary = mintCanary();
  const event = redactCanary(
    {
      type: 'structured',
      structured: { token: canary },
    },
    canary,
  );
  assertEquals(JSON.stringify(event).includes(canary), false);
  assertEquals(JSON.stringify(event).includes(OMIT_CANARY), true);
});

Deno.test('wrapUserData produces correct fence boundaries and strips spoofed inner fences', () => {
  const text = 'user text';
  const wrapped = wrapUserData(text);
  assertEquals(wrapped, `${USER_OPEN}\n${text}\n${USER_CLOSE}`);
});

Deno.test('redactCanary replacement text is the literal omit marker not empty string', () => {
  const canary = mintCanary();
  const event = redactCanary({ type: 'text', text: `leak ${canary}` }, canary);
  assertEquals(event.text, `leak [omitted - canary]`);
});

Deno.test('wrapUserData trims leading and trailing whitespace from inner content', () => {
  const wrapped = wrapUserData('  padded  ');
  assertEquals(wrapped, `${USER_OPEN}\npadded\n${USER_CLOSE}`);
});

Deno.test('wrapUserData strips spoofed fence tags from inner content', () => {
  const text = `before ${USER_OPEN} inside ${USER_CLOSE} after`;
  const wrapped = wrapUserData(text);
  assertEquals(wrapped.includes(USER_OPEN), true);
  assertEquals(wrapped.endsWith(USER_CLOSE), true);
  const inner = wrapped.slice(USER_OPEN.length + 1, wrapped.length - USER_CLOSE.length - 1);
  assertEquals(inner.includes(USER_OPEN), false);
  assertEquals(inner.includes(USER_CLOSE), false);
  assertEquals(inner.includes('before'), true);
  assertEquals(inner.includes('inside'), true);
  assertEquals(inner.includes('after'), true);
});

Deno.test('eventHasCanary returns false for structured event without canary', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary({ type: 'structured', structured: { note: 'safe data' } }, canary),
    false,
  );
});

Deno.test('eventHasCanary returns false for tool event without canary', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary(
      {
        type: 'tool',
        tool: { name: 'fn', arguments: { q: 'safe' } },
      },
      canary,
    ),
    false,
  );
});

Deno.test('eventHasCanary returns false for grounding event without canary', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary(
      {
        type: 'grounding',
        grounding: { sources: [], metadata: {} },
      },
      canary,
    ),
    false,
  );
});

Deno.test('eventHasCanary returns false for evidence event without canary', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary(
      {
        type: 'evidence',
        evidence: { provider: 'google', raw: {} },
      },
      canary,
    ),
    false,
  );
});

Deno.test('eventHasCanary returns false for sessionResumptionHandle without canary', () => {
  const canary = mintCanary();
  assertEquals(
    eventHasCanary(
      {
        type: 'done',
        sessionResumptionHandle: 'safe-handle-no-canary',
      },
      canary,
    ),
    false,
  );
});

Deno.test('createCanaryStreamGate emits at once text that cannot start a leak', () => {
  const gate = createCanaryStreamGate(FIXED_CANARY);
  const text = 'safe text with no opening of the token in it';
  assertEquals(gate.process(text), { leak: false, emit: text });
});

Deno.test('unlisted input.role is not interpolated into the system block', async () => {
  const phrase = 'unlisted-role-payload-qq';
  let system = '';
  async function* capture(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    ({ system } = req);
    yield { type: 'text', text: 'ok' };
  }
  await collect(
    runTurn(
      { profile: 'chat', input: { text: phrase, role: phrase } },
      {
        complete: capture,
      },
    ),
  );
  assertEquals(system.includes(phrase), false);
  assertEquals(system.includes('Reply in the structured turn schema.'), true);
});

Deno.test('eventHasCanary detects canary in text field of a text event', () => {
  const canary = mintCanary();
  assertEquals(eventHasCanary({ type: 'text', text: canary }, canary), true);
});

Deno.test('createCanaryStreamGate: process+flush total emitted bytes equals input length', () => {
  const canary = mintCanary();
  const gate = createCanaryStreamGate(canary);
  const text = 'safe text that is way longer than the canary overlap window and emits immediately';
  const r1 = gate.process(text);
  assertEquals(r1.leak, false);
  const r2 = gate.flush();
  assertEquals(r2.leak, false);
  if (!r1.leak && !r2.leak) {
    assertEquals(r1.emit.length + r2.emit.length, text.length);
  }
});

Deno.test('createCanaryStreamGate: second flush after first gives empty emit', () => {
  const canary = mintCanary();
  const gate = createCanaryStreamGate(canary);
  gate.process('safe content here');
  gate.flush();
  const r2 = gate.flush();
  assertEquals(r2.leak, false);
  if (!r2.leak) {
    assertEquals(r2.emit, '');
  }
});

Deno.test('runTurn catches a canary split across a tool step', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'canary_split_steps',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
    }),
  );
  let call = 0;
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      const canary = /[0-9a-f]{32}/.exec(req.system ?? '')?.[0] ?? '';
      const half = CANARY_OPENING;
      call += 1;
      if (call === 1) {
        yield { type: 'text', text: `One: ${canary.slice(0, half)}` };
        yield {
          type: 'tool',
          tool: { name: 'fetch_sensor', arguments: { sensor: 'soil' }, id: 'call_1' },
        };
        return;
      }
      yield { type: 'text', text: canary.slice(half) };
    },
  };
  const events = await collect(
    runTurn({ profile: 'canary_split_steps', input: { text: 'hi' } }, provider),
  );
  assertEquals(call, 2);
  assertEquals(
    events.some((event) => event.type === 'error' && event.errorKind === 'safety'),
    true,
  );
  assertEquals(events.findLast((event) => event.type === 'done')?.stop, {
    kind: 'filtered',
    native: 'canary',
  });
});

function hexBytes(canary: string): string {
  return (canary.match(/../g) ?? [])
    .map((pair) => String.fromCharCode(Number.parseInt(pair, 16)))
    .join('');
}

function charCodes(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

const FULLWIDTH_OFFSET = 0xfee0;
const LOOKALIKE: Record<string, string> = { a: 'а', c: 'с', e: 'е' };
const NATO: Record<string, string> = {
  a: 'alpha',
  b: 'bravo',
  c: 'charlie',
  d: 'delta',
  e: 'echo',
  f: 'foxtrot',
};
const DIGIT_NAMES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];

/** Every way a canary is written that the scan must read as the token. */
function encodedLeaks(canary: string): Record<string, string> {
  const hex = charCodes(canary).map((code) => code.toString(16));
  return {
    fullwidth: [...canary]
      .map((char) => String.fromCharCode(char.charCodeAt(0) + FULLWIDTH_OFFSET))
      .join(''),
    lookalikes: [...canary].map((char) => LOOKALIKE[char] ?? char).join(''),
    'prose separators': [...canary].join(', then '),
    'spelled out': [...canary]
      .map((char) => DIGIT_NAMES[Number(char)] ?? NATO[char] ?? char)
      .join(' '),
    'spelled letters as letters': [...canary]
      .map((char) => DIGIT_NAMES[Number(char)] ?? char)
      .join(' '),
    'base64 inside a sentence': btoa(`token: ${canary}`),
    'base64 url-safe, unpadded': btoa(canary)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, ''),
    'base64 of the bytes it spells': btoa(hexBytes(canary)),
    'percent-encoded': hex.map((pair) => `%${pair}`).join(''),
    'hex dump': hex.join(' '),
    'html entities': charCodes(canary)
      .map((code) => `&#${code};`)
      .join(''),
    'byte values': charCodes(hexBytes(canary)).join(', '),
    '0x bytes': (canary.match(/../g) ?? []).map((pair) => `0x${pair}`).join(', '),
    'first half': canary.slice(0, 16),
    'halves swapped': `${canary.slice(16)} and ${canary.slice(0, 16)}`,
  };
}

Deno.test('scanTextForCanaryLeak reads the canary through every encoding it detects', () => {
  const canary = mintCanary();
  for (const [name, leak] of Object.entries(encodedLeaks(canary))) {
    assertEquals([name, scanTextForCanaryLeak(`<< ${leak} >>`, canary)], [name, true]);
  }
});

Deno.test('redactCanaryText removes every encoding it detects', () => {
  const canary = mintCanary();
  for (const [name, leak] of Object.entries(encodedLeaks(canary))) {
    const redacted = redactCanaryText(`<< ${leak} >>`, canary);
    assertEquals([name, scanTextForCanaryLeak(redacted, canary)], [name, false]);
    assertEquals([name, redacted.startsWith('<< ') && redacted.endsWith(' >>')], [name, true]);
  }
});

Deno.test('scanTextForCanaryLeak needs 16 characters of the token in a run', () => {
  const canary = mintCanary();
  assertEquals(scanTextForCanaryLeak(`<< ${canary.slice(3, 19)} >>`, canary), true);
  assertEquals(scanTextForCanaryLeak(`<< ${canary.slice(3, 18)} >>`, canary), false);
});

Deno.test('scanTextForCanaryLeak reads token characters more than 32 apart as unrelated', () => {
  const canary = mintCanary();
  const filler = ' — and that is the whole story, told slowly — ';
  assertEquals(scanTextForCanaryLeak([...canary].join(filler), canary), false);
  // The opening is spent once that much text follows it, so nothing stays held.
  const text = `say ${canary.slice(0, 6)}${' '.repeat(40)}`;
  assertEquals(canaryHoldFrom(text, canary), text.length);
});

Deno.test('scanTextForCanaryLeak ignores numbers, spelled numbers, hashes, and base64', () => {
  const canary = mintCanary();
  for (const benign of [
    'Order 4417 shipped 2024-03-15 for $1,299.00; call 555-0142 or 555-0199 before 18:30.',
    'One or two ideas, maybe three. Alpha testing starts in five days; bravo to the team.',
    'Commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 is signed.',
    `Attachment: ${btoa('The quarterly report is attached, with the appendix and notes.')}`,
    'Pages 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 are ready.',
  ]) {
    assertEquals([benign, scanTextForCanaryLeak(benign, canary)], [benign, false]);
  }
});

Deno.test('canaryScanFrom rereads enough to see a leak that ends in new text', () => {
  const canary = mintCanary();
  const spelled = encodedLeaks(canary)['spelled out'];
  const text = `${'x'.repeat(5000)} ${spelled}`;
  const cut = text.length - 3;
  // Scanning only from the lookback finds what a scan of the whole text finds.
  assertEquals(scanTextForCanaryLeak(text.slice(canaryScanFrom(text, cut)), canary), true);
  assertEquals(canaryScanFrom('short', 5), 0);
});

Deno.test('canary stream gate catches a spelled-out leak split across chunks', () => {
  const canary = mintCanary();
  const spelled = encodedLeaks(canary)['spelled out'];
  const gate = createCanaryStreamGate(canary);
  let released = '';
  let leaked = false;
  for (const piece of spelled.match(/.{1,5}/gs) ?? []) {
    const step = gate.process(piece);
    if (step.leak) {
      leaked = true;
      break;
    }
    released += step.emit;
  }
  assertEquals(leaked, true);
  // What went out before the stop is less than a leak run.
  assertEquals(scanTextForCanaryLeak(released, canary), false);
});

Deno.test('canaryHoldFrom holds a spelled opening through a word the chunk cut off', () => {
  const canary = 'b8d3e3616fea1b7bfcb0bfb750bffe3d';
  // "e" is the start of "eight": it must not read as the letter e and break the opening.
  assertEquals(canaryHoldFrom('Sure: bravo e', canary), 'Sure: '.length);
  assertEquals(canaryHoldFrom('Sure: bravo eight', canary), 'Sure: '.length);
  // A cut word that cannot become token characters is not held.
  assertEquals(canaryHoldFrom('Sure: hel', canary), 'Sure: hel'.length);
});
