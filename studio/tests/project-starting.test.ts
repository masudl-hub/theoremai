import { assertEquals, assertRejects } from '@std/assert';
import { type Clock, onceAnswering } from '../ui/lib/project-starting.ts';

/** A clock the test moves: each wait passes that much time at once. */
function clock(): Clock & { waits: number } {
  let at = 0;
  const made = {
    waits: 0,
    now: () => at,
    wait: (ms: number) => {
      at += ms;
      made.waits += 1;
      return Promise.resolve();
    },
  };
  return made;
}

Deno.test('a server that answers at once is opened without waiting', async () => {
  const time = clock();
  assertEquals(await onceAnswering(() => Promise.resolve('project'), time), 'project');
  assertEquals(time.waits, 0);
});

Deno.test('a server still starting is asked again until it answers', async () => {
  const time = clock();
  let asked = 0;
  const open = () => (++asked < 4 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve('project'));
  assertEquals(await onceAnswering(open, time), 'project');
  assertEquals(asked, 4);
});

Deno.test('a server that answers badly is not asked again', async () => {
  const time = clock();
  let asked = 0;
  await assertRejects(() => onceAnswering(() => (asked++, Promise.reject(new Error('answered 500'))), time), Error, '500');
  assertEquals(asked, 1);
});

Deno.test('the page stops asking when no server has started in time', async () => {
  const time = clock();
  await assertRejects(() => onceAnswering(() => Promise.reject(new TypeError('Failed to fetch')), time), TypeError);
  assertEquals(time.now(), 10_000);
});
