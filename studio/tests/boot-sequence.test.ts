import { assertEquals } from '@std/assert';
import { type Boot, runBoot } from '../ui/lib/boot-sequence.ts';

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets every step that can run, run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A loader whose every wait is a gate the test opens, and a log of what it did, in order. */
function loader(over: Partial<Boot> = {}) {
  const log: string[] = [];
  const gates = { mark: gate(), page: gate(), pull: gate(), map: gate() };
  const stop = runBoot({
    reads: true,
    reduced: false,
    fadeMs: 140,
    settled: gates.page.promise,
    mapDrawn: gates.map.promise,
    markDrawn: () => gates.mark.promise,
    penHasStarted: () => true,
    pullIn: () => {
      log.push('pull in beside the rail');
      return gates.pull.promise;
    },
    sleep: (ms) => {
      log.push(`wait ${String(ms)}`);
      return Promise.resolve();
    },
    show: (phase) => void log.push(`show ${phase}`),
    reveal: () => void log.push('reveal'),
    ...over,
  });
  return { log, gates, stop };
}

Deno.test("a project's read: the mark gives way, the map starts as the panel pulls in, fades, then the page", async () => {
  const { log, gates } = loader();
  await settle();
  assertEquals(log, []);

  gates.mark.open();
  await settle();
  // The map is on the panel while it pulls in: the panel is never blank.
  assertEquals(log, ['wait 90', 'show map', 'pull in beside the rail']);

  gates.page.open();
  gates.pull.open();
  await settle();
  // The page is there, but the map has not drawn all of the read.
  assertEquals(log.length, 3);

  gates.map.open();
  await settle();
  assertEquals(log.slice(3), ['show leave', 'wait 140', 'reveal']);
});

Deno.test('a map drawn before the panel is in waits for the panel', async () => {
  const { log, gates } = loader();
  gates.mark.open();
  gates.page.open();
  gates.map.open();
  await settle();
  assertEquals(log, ['wait 90', 'show map', 'pull in beside the rail']);

  gates.pull.open();
  await settle();
  assertEquals(log.slice(3), ['show leave', 'wait 140', 'reveal']);
});

Deno.test('a page with no project to read: the drawn mark is held, then the page', async () => {
  const { log, gates } = loader({ reads: false });
  gates.page.open();
  await settle();
  assertEquals(log, []);
  gates.mark.open();
  await settle();
  assertEquals(log, ['wait 90', 'reveal']);
});

Deno.test('a page ready before the pen starts is shown at once, with no mark and no map', async () => {
  const { log, gates } = loader({ penHasStarted: () => false });
  gates.page.open();
  await settle();
  assertEquals(log, ['reveal']);
  // The mark's end, arriving later, starts nothing.
  gates.mark.open();
  await settle();
  assertEquals(log, ['reveal', 'wait 90']);
});

Deno.test('with reduced motion nothing is mapped: the mark is held a little longer, then the page', async () => {
  const { log, gates } = loader({ reads: false, reduced: true, penHasStarted: () => false });
  gates.page.open();
  gates.mark.open();
  await settle();
  assertEquals(log, ['wait 200', 'reveal']);
});

Deno.test('a loader that is stopped shows and reveals nothing more', async () => {
  const { log, gates, stop } = loader();
  gates.mark.open();
  await settle();
  stop();
  gates.page.open();
  gates.pull.open();
  gates.map.open();
  await settle();
  assertEquals(log, ['wait 90', 'show map', 'pull in beside the rail']);
});
