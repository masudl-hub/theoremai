import { assertEquals } from '@std/assert';
import type { ClientTurnOptions } from '../../src/host/mod.ts';
import type { LiveExecuteToolArgs, LiveSession, TurnEvent } from '../../src/kernel/types.ts';
import { attachStudioLiveSession } from '../../studio/live-session-bridge.ts';

function bridge(
  events: TurnEvent[],
  timeoutMs: number | null = 20,
  beforeEvent?: (event: TurnEvent) => void | Promise<void>,
  clientEvents?: ClientTurnOptions,
) {
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
  const done = attachStudioLiveSession(
    socket as never,
    session,
    'p',
    's',
    { close: () => {} } as never,
    undefined,
    { clientCallTimeoutMs: timeoutMs ?? undefined, beforeEvent, clientEvents },
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
  ({ type: 'tool', tool: { name: 't', callId, operationId: callId, arguments: {} } }) as TurnEvent;

Deno.test('the bridge hands the outcome of a page tool to executeTool as page.output', async () => {
  const b = bridge([]);
  b.message({ type: 'executeTool', callId: 'c1', operationId: 'c1', output: { done: true } });
  b.message({ type: 'executeTool', callId: 'c2', operationId: 'c2' });
  await wait(0);
  assertEquals(b.calls, [
    { callId: 'c1', operationId: 'c1', page: { output: { done: true } } },
    {
      callId: 'c2',
      operationId: 'c2',
    },
  ]);
  await b.end();
});

Deno.test('the bridge settles a call the browser never answered, and only that one', async () => {
  const b = bridge([call('slow'), call('fast')]);
  await wait(0);
  b.message({ type: 'executeTool', callId: 'fast', operationId: 'fast', output: 1 });
  await wait(60);
  assertEquals(b.calls, [
    { callId: 'fast', operationId: 'fast', page: { output: 1 } },
    { callId: 'slow', operationId: 'slow', page: { timedOut: true } },
  ]);
  await b.end();
});

Deno.test('with no timeout set, a call waits for the browser', async () => {
  const b = bridge([call('slow')], null);
  await wait(60);
  assertEquals(b.calls, []);
  await b.end();
});

Deno.test('a call that settles on its own is not timed out', async () => {
  const b = bridge([
    call('c1'),
    {
      type: 'tool',
      tool: { name: 't', callId: 'c1', operationId: 'c1', phase: 'cancel' },
    } as TurnEvent,
  ]);
  await wait(60);
  assertEquals(b.calls, []);
  await b.end();
});

Deno.test('checkpoint ownership is saved before a live checkpoint reaches the browser', async () => {
  let commit = () => {};
  const saved = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const checkpoint: TurnEvent = {
    type: 'provider_checkpoint',
    providerState: {
      protocol: 'protocol',
      provider: 'provider',
      version: 1,
      apiId: 'model',
      compatibilityKey: 'deployment',
      coveredHistoryLength: 0,
      coveredHistoryHash: 'history',
      data: { cursor: 'private-state' },
    },
  };
  const b = bridge([checkpoint], 20, () => saved);
  await wait(0);
  assertEquals(
    b.sent.some((line) => line.includes('private-state')),
    false,
  );
  commit();
  await wait(0);
  assertEquals(
    b.sent.some((line) => line.includes('private-state')),
    true,
  );
  await b.end();
});

Deno.test('a failed ownership write never advertises resumable native state', async () => {
  const checkpoint: TurnEvent = {
    type: 'provider_checkpoint',
    providerState: {
      protocol: 'protocol',
      provider: 'provider',
      version: 1,
      apiId: 'model',
      compatibilityKey: 'deployment',
      coveredHistoryLength: 0,
      coveredHistoryHash: 'history',
      data: { cursor: 'uncommitted-state' },
    },
  };
  const b = bridge([checkpoint], 20, () => Promise.reject(new Error('storage failed')));
  await wait(0);
  assertEquals(
    b.sent.some((line) => line.includes('uncommitted-state')),
    false,
  );
  await b.end();
});

Deno.test('the bridge words a failure for a visitor unless its caller says a builder reads it', async () => {
  const failed: TurnEvent = {
    type: 'error',
    errorKind: 'auth',
    error: "Sorry, the assistant can't connect at the moment.",
    errorInternal: "The vault has no credential in slot 'slot_a'",
  };
  const wording = async (clientEvents?: ClientTurnOptions) => {
    const b = bridge([failed], 20, undefined, clientEvents);
    await b.end();
    return b.sent.map((line) => JSON.parse(line)).find((line) => line.type === 'error');
  };
  assertEquals(await wording(), { type: 'error', errorKind: 'auth', error: failed.error });
  assertEquals(await wording({ reader: 'builder' }), {
    type: 'error',
    errorKind: 'auth',
    error: failed.errorInternal,
  });
});
