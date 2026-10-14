import { assertEquals } from '@std/assert';
import { stepOrder } from '../../src/kernel/engine/runner/step-order.ts';

/** Whether `promise` has settled once pending callbacks have run. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

Deno.test('one at a time, a call starts only once every call before it has settled', async () => {
  const order = stepOrder(['c1', 'c2', 'c3'], false);
  // why: c2 settles first, as a call the provider already failed does; c3 still waits for c1.
  order.settle('c2');
  const third = order.start('c3');
  assertEquals(await hasSettled(third), false);
  order.settle('c1');
  assertEquals(await hasSettled(third), true);
});

Deno.test('one at a time, a wait on a later call fails even past a settled call between', async () => {
  const order = stepOrder(['c1', 'c2', 'c3'], false);
  order.settle('c2');
  assertEquals(await order.wait('c1', ['c3']), { ok: false, reason: 'cycle', callIds: ['c3'] });
});

Deno.test('side by side, every call starts at once and a wait ends when its call settles', async () => {
  const order = stepOrder(['c1', 'c2'], true);
  assertEquals(await hasSettled(order.start('c2')), true);
  const waiting = order.wait('c1', ['c2']);
  assertEquals(await hasSettled(waiting), false);
  order.settle('c2');
  assertEquals(await waiting, { ok: true });
});

Deno.test('a call held in a loop of waits is released as failed when the loop closes', async () => {
  const order = stepOrder(['c1', 'c2'], true);
  const first = order.wait('c1', ['c2']);
  assertEquals(await order.wait('c2', ['c1']), {
    ok: false,
    reason: 'cycle',
    callIds: ['c1'],
  });
  assertEquals(await first, { ok: false, reason: 'cycle', callIds: ['c2'] });
});

Deno.test('a wait on a call outside the step fails as unknown', async () => {
  const order = stepOrder(['c1'], true);
  assertEquals(await order.wait('c1', ['c9']), { ok: false, reason: 'unknown', callIds: ['c9'] });
});

Deno.test('an aborted turn ends a held wait with the abort', async () => {
  const controller = new AbortController();
  const order = stepOrder(['c1', 'c2'], true, controller.signal);
  const waiting = order.wait('c1', ['c2']);
  controller.abort(new Error('stopped'));
  let reason = '';
  await waiting.catch((error: unknown) => {
    reason = error instanceof Error ? error.message : '';
  });
  assertEquals(reason, 'stopped');
});
