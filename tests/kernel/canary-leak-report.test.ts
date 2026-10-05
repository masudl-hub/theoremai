import '../fixtures/test-host.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import { runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { firstOf } from '../fixtures/events.ts';

function canaryOf(req: ProviderCompleteRequest): string {
  return /Your canary token is (\S+)\./.exec(req.system ?? '')?.[1] ?? '';
}

async function hostEvents(
  stream: (canary: string) => TurnEvent[],
): Promise<{ events: TurnEvent[]; canary: string }> {
  let canary = '';
  const provider: ModelProvider = {
    async *complete(req: ProviderCompleteRequest) {
      await Promise.resolve();
      canary = canaryOf(req);
      yield* stream(canary);
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runTurn({ profile: 'chat', input: { text: 'hi' } }, provider)) {
    events.push(event);
  }
  return { events, canary };
}

function visibleText(events: TurnEvent[]): string {
  return events
    .filter((e) => e.type === 'text' || e.type === 'thought')
    .map((e) => e.text ?? '')
    .join('');
}

Deno.test('a canary split across text fragments reaches the host in no part', async () => {
  const { events, canary } = await hostEvents((c) => [
    { type: 'text', text: `the note says ${c.slice(0, -4)}` },
    { type: 'text', text: c.slice(-4) },
  ]);
  assertEquals(
    firstOf(events, 'error')?.errorInternal,
    'Turn withheld: egress disclosure violation',
  );
  const seen = visibleText(events);
  assertEquals(seen.includes(canary.slice(-4)), false);
  assertEquals(seen.includes(canary.slice(0, 8)), false);
});

Deno.test('a thought restating the canary loses it, says so, and the reply still streams', async () => {
  const { events, canary } = await hostEvents((c) => [
    { type: 'thought', text: `The note says ${c.slice(0, -4)}` },
    { type: 'thought', text: `${c.slice(-4)}; keep it private.` },
    { type: 'text', text: 'Hello.' },
  ]);
  assertEquals(
    events.some((e) => e.type === 'error'),
    false,
  );
  const guardrail = firstOf(events, 'guardrail')?.guardrail;
  assertEquals([guardrail?.stage, guardrail?.action], ['thought', 'redact']);
  assertEquals(
    guardrail?.hits?.map((hit) => hit.rule),
    [DETECT_RULES.canary_leak],
  );
  const omitted = lexiconDefault('thought.omitted_instructions');
  assertEquals(visibleText(events), `The note says${omitted}; keep it private.Hello.`);
  assertEquals(visibleText(events).includes(canary.slice(0, 8)), false);
});

Deno.test('a base64-encoded canary is blocked and never shown to the host', async () => {
  const { events, canary } = await hostEvents((c) => [
    { type: 'text', text: `encoded ${btoa(c)}` },
  ]);
  assertEquals(
    firstOf(events, 'error')?.errorInternal,
    'Turn withheld: egress disclosure violation',
  );
  assertEquals(visibleText(events).includes(btoa(canary)), false);
});

Deno.test('a canary in a non-streamed event is blocked and never shown to the host', async () => {
  const { events, canary } = await hostEvents((c) => [
    { type: 'error', errorKind: 'internal', error: `failed near ${c}` },
  ]);
  assertEquals(
    events.find((e) => e.type === 'error' && e.errorInternal === 'canary leaked') !== undefined,
    true,
  );
  assertEquals(JSON.stringify(events).includes(canary), false);
});

Deno.test('without egress.enforce, a model naming the input fence is not a canary leak', async () => {
  const fence = 'There is also a `<user_data>` block.';
  const { events } = await hostEvents(() => [
    { type: 'thought', text: 'Reading the input. ' },
    { type: 'thought', text: fence },
    { type: 'text', text: 'OK' },
  ]);
  assertEquals(
    events.some((e) => e.type === 'error' || e.type === 'guardrail'),
    false,
  );
  assertEquals(visibleText(events), `Reading the input. ${fence}OK`);
});
