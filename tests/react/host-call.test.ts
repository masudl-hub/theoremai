import { assertEquals } from '@std/assert';
import {
  hostCallFailure,
  hostCallStatus,
  hostConsoleView,
  type ToolCall,
} from '../../react/src/client/host-call.ts';

const callIn = (state: unknown) => ({ state }) as unknown as ToolCall;
const failed = { error: 'The tool is unavailable.', errorKind: 'network' } as never;

Deno.test("a host call's status is its phase, else how its stream ended", () => {
  for (const phase of ['gate', 'complete', 'error', 'cancel'] as const) {
    assertEquals(
      hostCallStatus({ call: callIn({ phase }), failure: null, isRunning: false }),
      phase,
    );
  }
  assertEquals(
    hostCallStatus({ call: callIn({ phase: 'running' }), failure: null, isRunning: true }),
    'running',
  );
  assertEquals(hostCallStatus({ call: null, failure: failed, isRunning: false }), 'error');
  assertEquals(hostCallStatus({ call: null, failure: null, isRunning: false }), 'cancel');
});

Deno.test("a host call's failure reads its lexicon wording, with the detail only when it adds something", () => {
  assertEquals(hostCallFailure({ call: null, failure: failed, isRunning: false }), {
    title: 'The tool is unavailable.',
  });
  const errored = (failure: unknown) =>
    hostCallFailure({ call: callIn({ phase: 'error', failure }), failure: null, isRunning: false });
  assertEquals(errored({ error: 'Blocked.', message: 'rate limited' }), {
    title: 'Blocked.',
    description: 'rate limited',
  });
  assertEquals(errored({ error: 'Blocked.', message: 'Blocked.' }), { title: 'Blocked.' });
  assertEquals(errored({ message: 'rate limited' }), { title: 'rate limited' });
  assertEquals(
    hostCallFailure({ call: callIn({ phase: 'complete' }), failure: null, isRunning: false }),
    null,
  );
});

Deno.test("the console shows the picked tool's draft and its call on show", () => {
  const tools = [
    {
      name: 'weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    { name: 'places', inputSchema: { type: 'object' } },
  ];
  const calls = [
    { id: 'c3', name: 'weather' },
    { id: 'c2', name: 'places' },
    { id: 'c1', name: 'weather' },
  ];
  const fresh = hostConsoleView({ tools, picked: 'gone', drafts: {}, calls, shownId: null });
  assertEquals(fresh.tool, tools[0]);
  assertEquals(JSON.parse(fresh.text), { city: 'example' });
  assertEquals(fresh.shown, calls[0]);
  assertEquals(fresh.earlier, [calls[1], calls[2]]);
  const opened = hostConsoleView({
    tools,
    picked: 'weather',
    drafts: { weather: '{"city":"Oslo"}' },
    calls,
    shownId: 'c1',
  });
  assertEquals(opened.text, '{"city":"Oslo"}');
  assertEquals(opened.shown, calls[2]);
  const none = hostConsoleView({
    tools: [],
    picked: undefined,
    drafts: {},
    calls: [],
    shownId: null,
  });
  assertEquals(none, { tool: undefined, text: '', shown: null, earlier: [] });
});
