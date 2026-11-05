import { assert, assertFalse } from '@std/assert';
import { holdRuntime, type RuntimeHold } from '../ui/lib/runtime-hold.ts';

const runtime = (): RuntimeHold => ({ controller: new AbortController(), holds: 0 });
const settled = () => new Promise<void>((done) => queueMicrotask(done));

Deno.test('a runtime outlives the remount StrictMode rehearses in development', async () => {
  const held = runtime();
  const rehearsed = holdRuntime(held);
  rehearsed();
  holdRuntime(held);
  await settled();
  assertFalse(held.controller.signal.aborted);
});

Deno.test('a runtime let go of aborts its runs', async () => {
  const held = runtime();
  holdRuntime(held)();
  await settled();
  assert(held.controller.signal.aborted);
});

Deno.test('a newer runtime aborts the one it replaces, not itself', async () => {
  const old = runtime();
  const next = runtime();
  const letGo = holdRuntime(old);
  holdRuntime(next);
  letGo();
  await settled();
  assert(old.controller.signal.aborted);
  assertFalse(next.controller.signal.aborted);
});
