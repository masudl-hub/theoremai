import '../fixtures/test-host.ts';
import { assert, assertEquals, assertMatch, assertThrows } from '@std/assert';
import type { ModelEvent, TurnEvent, TurnModel } from '@theoremjs/agents/kernel';
import type { TraceRecord } from '@theoremjs/agents/observability';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import { compileStudio, createExampleDraft } from '../../studio/mod.ts';
import {
  createReplay,
  openingFromRecords,
  parseTraceFile,
  type ReplayDivergence,
  recordedTools,
  recordedTranscript,
  replayScript,
} from '../../studio/replay.ts';
import { runtimeProvider, type StudioRuntime, studioScope } from '../../studio/runtime-scope.ts';

const compiled = (() => {
  const result = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  return result;
})();

const AGENT = compiled.profile.id;

const CONVERT = { value: 10, from: 'km', to: 'mi' };

/** A model that converts once, then answers. */
function convertingModel(): TurnModel {
  let calls = 0;
  return {
    async *complete() {
      calls += 1;
      if (calls === 1) {
        yield { type: 'thought', text: 'Converting.' };
        yield { type: 'tool', tool: { callId: 'c1', name: 'convert_units', arguments: CONVERT } };
        yield { type: 'done', stop: { kind: 'tool' } };
      } else {
        yield { type: 'text', text: 'About 6.2 miles.' };
        yield { type: 'done', stop: { kind: 'completed' } };
      }
    },
  };
}

/** Runs one turn of `definition` on `runtime`, with its tools as `tools` gives them. */
async function runTurn(
  runtime: StudioRuntime,
  text: string,
  tools = compiled.customTools,
  definition = compiled.profile,
): Promise<{ events: TurnEvent[]; records: TraceRecord[] }> {
  const { scope, profile } = await studioScope(definition, tools, compiled.structured, runtime);
  const records: TraceRecord[] = [];
  const sink = {
    write: (record: TraceRecord) => {
      records.push(record);
      return Promise.resolve();
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of scope.runTurn(
    { profile: profile.id, input: { text } },
    runtimeProvider(runtime, scope, profile),
    sink,
  ))
    events.push(event);
  return { events, records };
}

const textOf = (events: readonly TurnEvent[]) =>
  events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');

const toolOutputs = (events: readonly TurnEvent[]) =>
  events.flatMap((event) =>
    event.type === 'tool' && event.tool.phase === 'complete' ? [event.tool.output] : [],
  );

/** The example profile, no longer offering convert_units. */
function withoutConvert(profile: typeof compiled.profile): typeof compiled.profile {
  const tools = (profile as { tools: { allow: string[] } }).tools;
  return {
    ...profile,
    tools: { ...tools, allow: tools.allow.filter((name) => name !== 'convert_units') },
  } as typeof profile;
}

async function recording() {
  const model = convertingModel();
  return await runTurn({ mode: 'byok', provider: () => model }, 'How far is 10 km in miles?');
}

Deno.test('a recorded turn reads back as what was sent, each model call, and each tool result', async () => {
  const { records } = await recording();
  const script = replayScript(records);
  assertEquals(script.agent, AGENT);
  assertEquals(script.turns.length, 1);
  const [turn] = script.turns;
  assertEquals(turn.text, 'How far is 10 km in miles?');
  assertEquals(
    turn.calls.map((call) => call.events.map((event) => event.type)),
    [
      ['thought', 'tool', 'done'],
      ['text', 'done'],
    ],
  );
  assertEquals(
    turn.results.map((result) => [result.name, result.failed]),
    [['convert_units', false]],
  );
  const kinds = recordedTranscript(script).map((block) => block.kind);
  assertEquals(kinds, ['user-text', 'thought', 'tool', 'text', 'turn-done']);
  assertEquals(
    openingFromRecords(records).map((block) => block.kind),
    kinds,
  );
});

Deno.test("a turn under the host's own span, which the record does not hold, reads back the same", async () => {
  const { records } = await recording();
  const hosted = records.map((record) => ({
    ...record,
    spans: record.spans.map((span) =>
      span.parentSpanId ? span : { ...span, parentSpanId: '00f067aa0ba902b7' },
    ),
  }));
  const read = (script: ReturnType<typeof replayScript>) =>
    script.turns.map(({ blocks, ...turn }) => ({
      ...turn,
      kinds: blocks.map((block) => block.kind),
    }));
  const original = replayScript(records);
  assertEquals(original.turns.length, 1);
  assertEquals(read(replayScript(hosted)), read(original));
});

Deno.test('a replay through the same profile answers as the recording did, reaching no model', async () => {
  const recorded = await recording();
  const script = replayScript(recorded.records);
  const diverged: ReplayDivergence[] = [];
  const replay = createReplay(script, AGENT, (each) => {
    diverged.push(each);
  });
  replay.startTurn(0);
  const again = await runTurn(
    { mode: 'byok', provider: replay.provider, toolHandlers: replay.toolHandlers },
    script.turns[0].text,
    recordedTools(compiled.customTools),
  );
  assertEquals(diverged, []);
  assertEquals(textOf(again.events), textOf(recorded.events));
  assertEquals(toolOutputs(again.events), toolOutputs(recorded.events));
});

Deno.test('a replay stops where the profile no longer offers a tool the recording calls', async () => {
  const script = replayScript((await recording()).records);
  const diverged: ReplayDivergence[] = [];
  const replay = createReplay(script, AGENT, (each) => {
    diverged.push(each);
  });
  const without = compiled.customTools.filter((tool) => tool.name !== 'convert_units');
  let failed: unknown;
  await runTurn(
    { mode: 'byok', provider: replay.provider, toolHandlers: replay.toolHandlers },
    script.turns[0].text,
    recordedTools(without),
    withoutConvert(compiled.profile),
  ).catch((err: unknown) => {
    failed = err;
  });
  assertEquals(
    diverged.map((each) => [each.turn, each.call]),
    [[0, 1]],
  );
  assertMatch(diverged[0].reason, /convert_units, which the profile no longer offers/);
  assertMatch(String(failed), /Replay stopped/);
});

Deno.test('a replay stops when the profile asks the model more often than the recording answered', async () => {
  const script = replayScript((await recording()).records);
  const diverged: ReplayDivergence[] = [];
  const replay = createReplay(script, AGENT, (each) => {
    diverged.push(each);
  });
  const model = replay.provider({ id: AGENT } as never);
  const request = { wireTools: [{ type: 'function', name: 'convert_units' }] } as never;
  const drain = async () => {
    const events: ModelEvent[] = [];
    for await (const event of model.complete(request)) events.push(event);
    return events;
  };
  await drain();
  await drain();
  let failed: unknown;
  await drain().catch((err: unknown) => {
    failed = err;
  });
  assert(failed instanceof Error);
  assertEquals(diverged, [
    {
      turn: 0,
      call: 3,
      reason: 'The profile asked the model a 3rd time this turn; the recording answered 2.',
    },
  ]);
});

const byStart = (a: { startTimeUnixNano: unknown }, b: { startTimeUnixNano: unknown }) =>
  BigInt(String(a.startTimeUnixNano)) < BigInt(String(b.startTimeUnixNano)) ? -1 : 1;

/** The recording, with `change` made to a copy of its one record (its first model call as `first chat`). */
async function changed(change: (spans: Map<string, TraceRecord['spans'][number]>) => void) {
  const [record] = structuredClone((await recording()).records);
  const spans = new Map(record.spans.map((span) => [span.name, span]));
  const first = record.spans.filter((span) => span.name.startsWith('chat ')).sort(byStart)[0];
  if (first) spans.set('first chat', first);
  change(spans);
  return replayScript([record]);
}

const appendPart = (value: unknown, part: Record<string, unknown>) => {
  const messages = value as { parts: Record<string, unknown>[] }[];
  messages.at(-1)?.parts.push(part);
};

Deno.test('a turn sent with a file holds no bytes to send again', async () => {
  const script = await changed((spans) => {
    const root = spans.get(`invoke_agent ${AGENT}`);
    appendPart(root?.attributes['gen_ai.input.messages'], {
      type: 'blob',
      modality: 'image',
      mime_type: 'image/png',
    });
  });
  assertEquals(script.turns[0].attachments, 1);
  assertEquals(script.turns[0].text, 'How far is 10 km in miles?');
});

Deno.test('a reply holding media the recording lacks stops the replay at that call', async () => {
  const script = await changed((spans) => {
    const chat = spans.get('first chat');
    appendPart(chat?.attributes['gen_ai.output.messages'], { type: 'blob', modality: 'image' });
  });
  assert(script.turns[0].calls[0].missing);
  const diverged: ReplayDivergence[] = [];
  const replay = createReplay(script, AGENT, (each) => {
    diverged.push(each);
  });
  let failed: unknown;
  await runTurn(
    { mode: 'byok', provider: replay.provider, toolHandlers: replay.toolHandlers },
    script.turns[0].text,
    recordedTools(compiled.customTools),
  ).catch((err: unknown) => {
    failed = err;
  });
  assert(failed);
  assertEquals(diverged, [
    { turn: 0, call: 1, reason: 'The recording does not hold all of this reply.' },
  ]);
});

Deno.test('a turn that failed shows its failure as the person saw it', async () => {
  const script = await changed((spans) => {
    const root = spans.get(`invoke_agent ${AGENT}`);
    if (root) root.status = { code: 'ERROR', message: 'The tool did not answer.' };
  });
  const kinds = recordedTranscript(script).map((block) => block.kind);
  assert(kinds.includes('error'), kinds.join(', '));
});

Deno.test('every tool but an agent is answered by a handler in a replay', () => {
  const tools = recordedTools(compiled.customTools);
  assertEquals(tools.length, compiled.customTools.length);
  for (const tool of tools) {
    if (tool.type === 'agent') continue;
    assertEquals(tool.type, 'function');
    assert(!('stubResponse' in tool), tool.name);
  }
});

Deno.test('a trace file is the records the studio downloads, one record, or JSONL', async () => {
  const { records } = await recording();
  assertEquals(parseTraceFile(JSON.stringify(records)).length, records.length);
  assertEquals(parseTraceFile(JSON.stringify(records[0])).length, 1);
  const jsonl = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  assertEquals(parseTraceFile(jsonl), parseTraceFile(JSON.stringify(records)));
  assertThrows(() => parseTraceFile('{nope'), Error, 'This file is not JSON.');
  assertThrows(
    () => parseTraceFile(`${JSON.stringify(records[0])}\n{nope\n`),
    Error,
    'Line 2 of this file is not JSON.',
  );
  assertThrows(
    () => parseTraceFile(`${JSON.stringify(records[0])}\n${JSON.stringify({ spans: 3 })}`),
    Error,
    'This file is not a Theorem trace (record 2).',
  );
  assertThrows(
    () => parseTraceFile(JSON.stringify([records[0], { spans: 3 }])),
    Error,
    'This file is not a Theorem trace (record 2).',
  );
});

Deno.test('a turn set again goes on with the calls it had left', async () => {
  const script = replayScript((await recording()).records);
  const diverged: ReplayDivergence[] = [];
  const replay = createReplay(script, AGENT, (each) => {
    diverged.push(each);
  });
  const model = replay.provider({ id: AGENT } as never);
  const request = { wireTools: [{ type: 'function', name: 'convert_units' }] } as never;
  const first = async () => {
    const events: ModelEvent[] = [];
    for await (const event of model.complete(request)) events.push(event);
    return events[0]?.type;
  };
  assertEquals(await first(), 'thought');
  replay.startTurn(1);
  replay.startTurn(0);
  assertEquals(await first(), 'text');
  assertEquals(diverged, []);
});

Deno.test('a recorded tool shows the output the person saw, not the fenced text the model read', async () => {
  const { events, records } = await recording();
  for (const span of records.flatMap((record) => record.spans))
    if ('gen_ai.tool.call.result' in span.attributes)
      span.attributes['gen_ai.tool.call.result'] =
        '<tool_data tool="convert_units" origin="http">\n{"miles":6.2}\n</tool_data>';
  const tool = recordedTranscript(replayScript(records)).find((block) => block.kind === 'tool');
  assert(tool?.kind === 'tool' && tool.tool.state?.phase === 'complete');
  assertEquals(tool.tool.state.output, toolOutputs(events)[0]);
});
