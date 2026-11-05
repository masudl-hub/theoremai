import { assertEquals } from '@std/assert';
import { pairAt } from '../ports.mjs';
import { EVENTS_PATH, eventLine, STATUS_PATH, streamedEvents, studiosOn } from '../read-studio.mjs';
import { STUDIO_BASE } from '../server/handler.ts';

Deno.test('the commands read where the server answers', () => {
  assertEquals(STATUS_PATH, `${STUDIO_BASE}/status`);
  assertEquals(EVENTS_PATH, `${STUDIO_BASE}/events`);
});

Deno.test('only the studios open on the setups asked for are read', () => {
  const held = [
    { pair: pairAt(0), setup: '/a/studio.setup.ts', free: false },
    { pair: pairAt(1), free: true },
    { pair: pairAt(2), setup: '/b/studio.setup.ts', free: false },
  ];
  assertEquals(
    studiosOn(held, new Set(['/b/studio.setup.ts'])).map((one) => one.pair),
    [pairAt(2)],
  );
  assertEquals(studiosOn(held, new Set()), []);
});

Deno.test('an event is one line, with its further lines under it and its repeats counted', () => {
  const at = new Date(2026, 9, 27, 15, 4, 5).toISOString();
  assertEquals(eventLine({ at, kind: 'page', text: 'the page: boom' }), '15:04:05 the page: boom');
  assertEquals(
    eventLine({ at, kind: 'run', text: 'a run failed\nat step 2', repeated: 3 }),
    '15:04:05 a run failed\n         at step 2 (×3)',
  );
});

Deno.test('a followed stream gives each event as it arrives, split anywhere', async () => {
  const sent =
    'data: {"at":"x","kind":"page","text":"one"}\n\n: kept open\n\ndata: {"at":"y","kind":"look","text":"two"}\n\n';
  const bytes = new TextEncoder().encode(sent);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
      controller.close();
    },
  });
  assertEquals(
    (await Array.fromAsync(streamedEvents(body))).map((event) => event.text),
    ['one', 'two'],
  );
});
