import { assertEquals } from '@std/assert';
import { createRuns, untilRead } from '../../studio/server/runs.ts';

Deno.test('a waiter runs in the tick the last run ends, and ending twice counts once', () => {
  const said: string[] = [];
  const runs = createRuns(() => said.push('idle'));
  const first = runs.begin();
  const second = runs.begin();
  runs.whenIdle(() => said.push('swap'));
  first();
  first();
  assertEquals([said, runs.busy()], [[], true]);
  second();
  assertEquals([said, runs.busy()], [['swap', 'idle'], false]);
  runs.whenIdle(() => said.push('at once'));
  assertEquals(said.at(-1), 'at once');
});

Deno.test('a run started by a waiter holds the next waiter back', () => {
  const said: string[] = [];
  const runs = createRuns(() => said.push('idle'));
  const first = runs.begin();
  let next = () => {};
  runs.whenIdle(() => {
    next = runs.begin();
  });
  runs.whenIdle(() => said.push('swap'));
  first();
  assertEquals(said, []);
  next();
  assertEquals(said, ['swap', 'idle']);
});

Deno.test('a run ends when its body is read to the end', async () => {
  let ends = 0;
  const answer = untilRead(new Response('a line\n'), () => {
    ends += 1;
  });
  assertEquals(ends, 0);
  assertEquals(await answer.text(), 'a line\n');
  assertEquals(ends, 1);
});

Deno.test('a run ends when the page drops its body, and the drop reaches the load', async () => {
  let ends = 0;
  let dropped = false;
  const held = new ReadableStream<Uint8Array>({
    cancel() {
      dropped = true;
    },
  });
  const answer = untilRead(new Response(held), () => {
    ends += 1;
  });
  await answer.body?.cancel();
  assertEquals([ends, dropped], [1, true]);
});

Deno.test('a run with no body ends at once', () => {
  let ends = 0;
  untilRead(new Response(null, { status: 204 }), () => {
    ends += 1;
  });
  assertEquals(ends, 1);
});

Deno.test('a run ends when its body fails', async () => {
  let ends = 0;
  const broken = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('gone');
    },
  });
  const answer = untilRead(new Response(broken), () => {
    ends += 1;
  });
  const read = await answer.text().catch((error: Error) => error.message);
  assertEquals([read, ends], ['gone', 1]);
});
