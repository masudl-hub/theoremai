import { assert, assertEquals } from '@std/assert';
import { defineProfile } from '../../mod.ts';
import { browserPlaygroundLiveConnection } from '../../playground/browser-live.ts';
import { MockLiveWebSocket } from '../fixtures/live-socket.ts';

Deno.test('browser live sessions resolve registered providers with the host socket transport', async () => {
  const wire = new MockLiveWebSocket();
  const profile = defineProfile({
    id: 'browser.live',
    type: 'live',
    identity: { handle: 'Live' },
    models: { main: { provider: 'google', apiId: 'gemini-3.8-live', keySlot: 'identity' } },
    tools: { allow: [] },
    live: { voice: 'Aoede', ingress: { text: true, audio: false, video: false } },
  });
  const connection = browserPlaygroundLiveConnection(
    { agentId: profile.id, profile, customTools: [] },
    {
      mode: 'byok',
      providers: {
        vault: { identity: 'fixture-key' },
        openWebSocket: () => {
          setTimeout(() => wire.open(), 0);
          return Promise.resolve(wire as unknown as WebSocket);
        },
      },
    },
  );
  assert(connection.createSocket);
  const socket = connection.createSocket();
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let lastType = 'none';
  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      lastType = 'opened';
      socket.send(JSON.stringify({ type: 'open' }));
    };
    socket.onclose = () =>
      reject(new Error(`Relay closed after ${lastType}, wire sends=${wire.sent.length}`));
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        lastType = `data:${typeof event.data}`;
        return;
      }
      const row = JSON.parse(event.data);
      lastType = row.type;
      if (row.type === 'ready') resolve();
      if (row.type === 'error') reject(new Error(row.error));
    };
    stopTimer = setTimeout(
      () =>
        reject(
          new Error(
            `Live relay did not open: state=${socket.readyState} sends=${wire.sent.length} last=${lastType}`,
          ),
        ),
      1000,
    );
  });
  try {
    await ready;
    assertEquals(
      wire.sent.some((row) => row.includes('"setup"')),
      true,
    );
    socket.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(wire.readyState, 3);
  } finally {
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    socket.close();
  }
});
