import { assertEquals } from '@std/assert';
import { attachPlaygroundLiveSession } from '../../playground/live-session-bridge.ts';
import type { LiveExecuteToolArgs, LiveSession, TurnEvent } from '../../src/kernel/types.ts';

function bridge(events: TurnEvent[], timeoutMs = 20) {
  const listeners: Record<string, (event: { data: unknown }) => void> = {};
  const sent: string[] = [];
  const calls: LiveExecuteToolArgs[] = [];
  let finish = () => {};
  const session = {
    events: async function* () {
      yield* events;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    executeTool: (args: LiveExecuteToolArgs) => {
      calls.push(args);
      return Promise.resolve({});
    },
    close: () => Promise.resolve(),
  } as unknown as LiveSession;
  const socket = {
    send: (data: string) => void sent.push(data),
    close: () => {},
    addEventListener: (type: string, fn: (event: { data: unknown }) => void) => {
      listeners[type] = fn;
    },
  };
  const done = attachPlaygroundLiveSession(
    socket as never,
    session,
    'p',
    's',
    { close: () => {} } as never,
    undefined,
    { clientCallTimeoutMs: timeoutMs },
  );
  return {
    calls,
    sent,
    message: (body: unknown) => listeners.message?.({ data: JSON.stringify(body) }),
    end: async () => {
      finish();
      await done;
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (callId: string) =>
  ({ type: 'tool', tool: { name: 't', callId, arguments: {} } }) as TurnEvent;

Deno.test('the bridge hands the outcome of a page tool to executeTool as page.output', async () => {
  const b = bridge([]);
  b.message({ type: 'executeTool', callId: 'c1', output: { done: true } });
  b.message({ type: 'executeTool', callId: 'c2' });
  await wait(0);
  assertEquals(b.calls, [
    { callId: 'c1', page: { output: { done: true } } },
    {
      callId: 'c2',
    },
  ]);
  await b.end();
});

Deno.test('the bridge settles a call the browser never answered, and only that one', async () => {
  const b = bridge([call('slow'), call('fast')]);
  await wait(0);
  b.message({ type: 'executeTool', callId: 'fast', output: 1 });
  await wait(60);
  assertEquals(b.calls, [
    { callId: 'fast', page: { output: 1 } },
    { callId: 'slow', page: { timedOut: true } },
  ]);
  await b.end();
});

Deno.test('a call that settles on its own is not timed out', async () => {
  const b = bridge([
    call('c1'),
    { type: 'tool', tool: { name: 't', callId: 'c1', phase: 'cancel' } } as TurnEvent,
  ]);
  await wait(60);
  assertEquals(b.calls, []);
  await b.end();
});
