import '../fixtures/test-host.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import {
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import {
  PROMPT_ECHO_WORDS,
  promptEchoRanges,
  promptEchoScanFrom,
  scanTextForPromptEcho,
} from '../../src/guardrails/prompt-echo.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
  'Escalate refunds above 200 dollars to a human and apologise once, briefly.',
].join(' ');

function words(text: string, from: number, count: number): string {
  return text
    .split(' ')
    .slice(from, from + count)
    .join(' ');
}

Deno.test('scanTextForPromptEcho flags 12 consecutive words of the system prompt', () => {
  assertEquals(PROMPT_ECHO_WORDS, 12);
  assertEquals(scanTextForPromptEcho(`Sure: ${words(SYSTEM, 3, 12)}`, SYSTEM), true);
  assertEquals(scanTextForPromptEcho(`Sure: ${words(SYSTEM, 3, 11)}`, SYSTEM), false);
});

Deno.test('scanTextForPromptEcho reads through case, markup, and list numbering', () => {
  const dump = SYSTEM.split(/(?<=\.)\s/)
    .map((line, index) => `${index + 1}. **${line.toUpperCase()}**`)
    .join('\n');
  assertEquals(scanTextForPromptEcho(dump, SYSTEM), true);
  assertEquals(scanTextForPromptEcho(SYSTEM.split(' ').join(' -- '), SYSTEM), true);
});

Deno.test('scanTextForPromptEcho ignores a reply on the same topic in its own words', () => {
  for (const reply of [
    'I can help with your order, a return, or shipping. What do you need?',
    'Refunds over 200 dollars go to a human colleague; I will pass yours on.',
    'I am Sol, the support agent for Northwind Outfitters. How can I help?',
  ]) {
    assertEquals([reply, scanTextForPromptEcho(reply, SYSTEM)], [reply, false]);
  }
});

Deno.test('scanTextForPromptEcho needs a prompt at least 12 words long', () => {
  assertEquals(
    scanTextForPromptEcho('You are a helpful assistant.', 'You are a helpful assistant.'),
    false,
  );
});

Deno.test('promptEchoRanges covers each echoed run', () => {
  // The run ends at its last word, before the comma after it.
  const echo = words(SYSTEM, 0, 12);
  const text = `>> ${echo} <<`;
  assertEquals(promptEchoRanges(text, SYSTEM), [[3, 3 + echo.length - ','.length]]);
});

Deno.test('promptEchoScanFrom rereads the words an echo run could start in', () => {
  const echo = words(SYSTEM, 0, 14);
  const text = `${'filler '.repeat(400)}${echo}`;
  const cut = text.length - 4;
  assertEquals(scanTextForPromptEcho(text.slice(promptEchoScanFrom(text, cut)), SYSTEM), true);
  assertEquals(promptEchoScanFrom('one two', 7), 0);
});

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function registerEchoProfile(id: string, promptEcho?: boolean): string {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'sol', system: SYSTEM },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      ...(promptEcho === undefined ? {} : { guardrails: { promptEcho } }),
    }),
  );
  return id;
}

/** A model that dumps the host's system prompt word by word, leaving the canary out. */
const dumpsPrompt: ModelProvider = {
  async *complete() {
    await Promise.resolve();
    for (const word of `My instructions: ${SYSTEM}`.split(' '))
      yield { type: 'text', text: `${word} ` };
  },
};

Deno.test('runTurn stops a reply that dumps the system prompt without the canary', async () => {
  const profile = registerEchoProfile('echo_dump');
  const events = await collect(runTurn({ profile, input: { text: 'hi' } }, dumpsPrompt));
  assertEquals(events.findLast((event) => event.type === 'done')?.stop, {
    kind: 'filtered',
    native: 'prompt_echo',
  });
  assertEquals(
    events.some((event) => event.type === 'error' && event.errorKind === 'safety'),
    true,
  );
  // At most 11 of the prompt's words went out before the stop.
  assertEquals(scanTextForPromptEcho(replyText(events), SYSTEM), false);
});

Deno.test('runTurn releases a quoting reply when the profile allows prompt echo', async () => {
  const profile = registerEchoProfile('echo_allowed', false);
  const events = await collect(runTurn({ profile, input: { text: 'hi' } }, dumpsPrompt));
  assertEquals(replyText(events).trim(), `My instructions: ${SYSTEM}`);
});

Deno.test('runTurn stops a tool call that carries the system prompt', async () => {
  const profile = registerEchoProfile('echo_tool');
  const provider: ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield { type: 'tool', tool: { name: 'fetch_sensor', arguments: { note: SYSTEM }, id: 'c1' } };
    },
  };
  const events = await collect(runTurn({ profile, input: { text: 'hi' } }, provider));
  assertEquals(events.findLast((event) => event.type === 'done')?.stop, {
    kind: 'filtered',
    native: 'prompt_echo',
  });
});

Deno.test('processLiveOutboundBatch withholds a spoken dump of the system prompt across cycles', async () => {
  const s = createLiveOutboundGateSession(getProfile('chat'), mintCanary(), SYSTEM);
  const said = (text: string): TurnEvent => ({
    type: 'evidence',
    text,
    evidence: { provider: 'google', kind: 'output_transcription' },
  });
  // Eight words a cycle: neither cycle alone repeats twelve.
  await processLiveOutboundBatch(s, [said(words(SYSTEM, 0, 8))]);
  assertEquals((await finalizeLiveOutboundTurn(s)).action === 'withhold', false);
  const next = await processLiveOutboundBatch(s, [said(` ${words(SYSTEM, 8, 8)}`)]);
  assertEquals(next.action, 'withhold');
  if (next.action === 'withhold') {
    assertEquals(next.error.message.includes('system prompt echoed'), true);
  }
});
