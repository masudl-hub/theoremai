import { assertEquals } from '@std/assert';
import { createBootHolds } from '../../studio/ui/lib/boot-hold.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function track(promise: Promise<unknown>) {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
}

Deno.test('with nothing held, the holds settle once the page has committed', async () => {
  const holds = createBootHolds();
  let commit = () => {};
  const settled = track(holds.settled(new Promise<void>((resolve) => (commit = resolve))));
  await tick();
  assertEquals(settled.done, false);
  commit();
  await tick();
  assertEquals(settled.done, true);
});

Deno.test('a hold made before the commit is gathered, and the holds settle when it is released', async () => {
  const holds = createBootHolds();
  let commit = () => {};
  const settled = track(holds.settled(new Promise<void>((resolve) => (commit = resolve))));
  const release = holds.holdUntil();
  commit();
  await tick();
  assertEquals(settled.done, false);
  release();
  await tick();
  assertEquals(settled.done, true);
});

Deno.test('a hold made while others are waited on is waited on too', async () => {
  const holds = createBootHolds();
  const first = holds.holdUntil();
  const settled = track(holds.settled(Promise.resolve()));
  await tick();
  const second = holds.holdUntil();
  first();
  await tick();
  assertEquals(settled.done, false);
  second();
  await tick();
  assertEquals(settled.done, true);
});

Deno.test('a failed piece still lets the page show', async () => {
  const holds = createBootHolds();
  holds.hold(Promise.reject(new Error('the preview did not load')));
  const settled = track(holds.settled(Promise.resolve()));
  await tick();
  assertEquals(settled.done, true);
});

Deno.test('once the holds have settled, a new hold does nothing', async () => {
  const holds = createBootHolds();
  await holds.settled(Promise.resolve());
  holds.holdUntil();
  const again = track(holds.settled(Promise.resolve()));
  await tick();
  assertEquals(again.done, true);
});
