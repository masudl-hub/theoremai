import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { jsonlSink } from '../../src/observability/jsonl.ts';
import { STUB_WRITE, stubRecord } from '../fixtures/trace-record.ts';

Deno.test('jsonlSink rejects unsafe trace directories before filesystem access', () => {
  assertThrows(() => jsonlSink('traces'), Error, 'absolute');
  assertThrows(() => jsonlSink(`${Deno.cwd()}/traces`), Error, 'outside');
  assertThrows(
    () => jsonlSink(`${Deno.cwd()}/../${Deno.cwd().split('/').at(-1)}/traces`),
    Error,
    'outside',
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A JSONL sink on 16/08/2026 over a directory holding one file from 01/01/2000. */
async function sinkWithStaleDay() {
  const dir = await Deno.makeTempDir();
  const stale = `${dir}/turns-2000-01-01.jsonl`;
  await Deno.writeTextFile(stale, '{}\n');
  const sink = jsonlSink(dir, { now: () => Date.parse('2026-08-16T00:00:00.000Z') });
  return { dir, stale, sink };
}

Deno.test('jsonl sink writes a day file and drops files past the record retention', async () => {
  const { dir, stale, sink } = await sinkWithStaleDay();
  await sink.write(stubRecord(), STUB_WRITE);
  assertEquals(await exists(stale), false);
  const today = await Deno.readTextFile(`${dir}/turns-2026-08-16.jsonl`);
  assertEquals(today.includes('"v":3'), true);
});

Deno.test('jsonl sink keeps every file when retention is 0 or less', async () => {
  for (const retainForDays of [0, -1]) {
    const { stale, sink } = await sinkWithStaleDay();
    await sink.write(stubRecord(), { ...STUB_WRITE, retainForDays });
    assertEquals(await exists(stale), true);
  }
});

Deno.test('jsonl sink creates its directory and files readable by the host user only', async () => {
  const root = await Deno.makeTempDir();
  const dir = `${root}/traces`;
  await jsonlSink(dir, { now: () => Date.parse('2026-08-16T00:00:00.000Z') }).write(
    stubRecord(),
    STUB_WRITE,
  );
  const permissions = (path: string) => Deno.stat(path).then((info) => (info.mode ?? 0) & 0o777);
  assertEquals(await permissions(dir), 0o700);
  assertEquals(await permissions(`${dir}/turns-2026-08-16.jsonl`), 0o600);
  await Deno.remove(root, { recursive: true });
});

Deno.test('jsonl sink starts a new file once the day file reaches the profile rotate size', async () => {
  const dir = await Deno.makeTempDir();
  const at = Date.parse('2026-08-16T00:00:00.000Z');
  const sink = jsonlSink(dir, { now: () => at });
  // A 1 MiB day file is full at `rotateAfterMiB: 1` and has room at 2.
  await Deno.writeTextFile(`${dir}/turns-2026-08-16.jsonl`, 'x'.repeat(1024 * 1024));
  await sink.write(stubRecord(), { ...STUB_WRITE, rotateAfterMiB: 1 });
  assertEquals(await exists(`${dir}/turns-2026-08-16-${at}.jsonl`), true);
  await sink.write(stubRecord(), { ...STUB_WRITE, rotateAfterMiB: 2 });
  const day = await Deno.readTextFile(`${dir}/turns-2026-08-16.jsonl`);
  assertEquals(day.length, 1024 * 1024);
  await Deno.remove(dir, { recursive: true });
});

Deno.test('jsonl sink keeps writing to the newest file until it too is full', async () => {
  const dir = await Deno.makeTempDir();
  let at = Date.parse('2026-08-16T00:00:00.000Z');
  const sink = jsonlSink(dir, { now: () => at });
  await Deno.writeTextFile(`${dir}/turns-2026-08-16.jsonl`, 'x'.repeat(1024 * 1024));
  for (let i = 0; i < 3; i++) {
    at += 1;
    await sink.write(stubRecord(), { ...STUB_WRITE, rotateAfterMiB: 1 });
  }
  const start = Date.parse('2026-08-16T00:00:00.000Z');
  const names = (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
  assertEquals(names, [`turns-2026-08-16-${start + 1}.jsonl`, 'turns-2026-08-16.jsonl']);
  const rotated = await Deno.readTextFile(`${dir}/turns-2026-08-16-${start + 1}.jsonl`);
  assertEquals(rotated.trimEnd().split('\n').length, 3);
  await Deno.writeTextFile(`${dir}/turns-2026-08-16-${start + 1}.jsonl`, 'x'.repeat(1024 * 1024));
  at += 1;
  await sink.write(stubRecord(), { ...STUB_WRITE, rotateAfterMiB: 1 });
  assertEquals(await exists(`${dir}/turns-2026-08-16-${at}.jsonl`), true);
  await Deno.remove(dir, { recursive: true });
});
