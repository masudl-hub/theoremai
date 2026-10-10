import { assertEquals } from '@std/assert';
import { createWatchFeed, type FolderWatch, watchFiles } from '../../studio/server/watch.ts';

/** A folder watch the test feeds by hand. */
function fakeWatch() {
  const opened: string[][] = [];
  let push: (() => void) | undefined;
  let end: (() => void) | undefined;
  const watch = (folders: string[]): FolderWatch => {
    opened.push(folders);
    let closed = false;
    return {
      close: () => {
        closed = true;
        end?.();
      },
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          await new Promise<void>((resolve) => {
            push = resolve;
            end = resolve;
          });
          if (!closed) yield {};
        }
      },
    };
  };
  return { opened, watch, write: () => push?.() };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test('a run of writes is told once, when it settles, with the files that changed', async () => {
  const fake = fakeWatch();
  const told: string[][] = [];
  let changed = ['setup.ts'];
  const watching = watchFiles({
    files: () => ['/project/setup.ts', '/project/lib/tools.ts'],
    changed: () => Promise.resolve(changed),
    tell: (files) => told.push(files),
    watch: fake.watch,
    settle: 20,
  });
  await wait(1);
  assertEquals(fake.opened, [['/project', '/project/lib']]);
  fake.write();
  await wait(5);
  fake.write();
  await wait(5);
  assertEquals(told, []);
  await wait(40);
  assertEquals(told, [['setup.ts']]);

  // A write that leaves the files as the project loaded them, the studio's own Save, tells nothing.
  changed = [];
  fake.write();
  await wait(40);
  assertEquals(told, [['setup.ts']]);
  watching.stop();
});

Deno.test('a file in a new folder is watched from the next change', async () => {
  const fake = fakeWatch();
  let files = ['/project/setup.ts'];
  const watching = watchFiles({
    files: () => files,
    changed: () => Promise.resolve(['setup.ts']),
    tell: () => undefined,
    watch: fake.watch,
    settle: 5,
  });
  await wait(1);
  files = ['/project/setup.ts', '/project/more/tools.ts'];
  fake.write();
  await wait(30);
  assertEquals(fake.opened, [['/project'], ['/project', '/project/more']]);
  watching.stop();
});

Deno.test('every subscribed page is sent the files, as server-sent events', async () => {
  const feed = createWatchFeed();
  const response = feed.subscribe({ vary: 'origin' });
  assertEquals(response.headers.get('content-type'), 'text/event-stream');
  assertEquals(response.headers.get('vary'), 'origin');
  const reader = response.body?.getReader();
  const read = async () => new TextDecoder().decode((await reader?.read())?.value);
  assertEquals(await read(), ': watching\n\n');
  feed.tell(['setup.ts']);
  assertEquals(await read(), 'data: {"files":["setup.ts"]}\n\n');
  await reader?.cancel();
  feed.tell(['setup.ts']);
});
