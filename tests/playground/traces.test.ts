import { assertEquals } from '@std/assert';
import {
  compilePlayground,
  createExampleDraft,
  createPlaygroundTraceRouter,
  createPlaygroundTransport,
  PLAYGROUND_RUN_METADATA_KEY,
} from '../../playground/mod.ts';
import { parseLiveServerEnvelope } from '../../react/src/client/live-messages.ts';
import { createTraceFeed } from '../../react/src/client/trace-feed.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { STUB_WRITE, stubRecord, stubSpan } from '../fixtures/trace-record.ts';

function recordFor(metadata: Record<string, unknown> | undefined): TraceRecord {
  return { ...stubRecord(), ...(metadata ? { metadata } : {}), spans: [stubSpan()] };
}

Deno.test('the trace router hands each record to the run that wrote it, while its route is open', async () => {
  const router = createPlaygroundTraceRouter();
  const first: TraceRecord[] = [];
  const second: TraceRecord[] = [];
  const a = router.route((record) => first.push(record));
  const b = router.route((record) => second.push(record));
  assertEquals(
    a.metadata[PLAYGROUND_RUN_METADATA_KEY] === b.metadata[PLAYGROUND_RUN_METADATA_KEY],
    false,
  );

  const forA = recordFor({ ...a.metadata, host: 'kept' });
  await router.sink.write(forA, STUB_WRITE);
  await router.sink.write(recordFor(b.metadata), STUB_WRITE);
  await router.sink.write(recordFor(undefined), STUB_WRITE);
  await router.sink.write(recordFor({ [PLAYGROUND_RUN_METADATA_KEY]: 'unknown' }), STUB_WRITE);
  assertEquals(first, [forA]);
  assertEquals(second.length, 1);

  a.close();
  await router.sink.write(recordFor(a.metadata), STUB_WRITE);
  assertEquals(first.length, 1);
});

Deno.test('the trace feed keeps records in arrival order and tells its listeners', () => {
  const feed = createTraceFeed();
  let heard = 0;
  const unsubscribe = feed.subscribe(() => heard++);
  const before = feed.records();
  const record = recordFor(undefined);
  feed.push(record);
  assertEquals(feed.records(), [record]);
  assertEquals(before, []);
  assertEquals(heard, 1);
  unsubscribe();
  feed.push(record);
  assertEquals(heard, 1);
  assertEquals(feed.records().length, 2);
});

Deno.test('a playground run stream sends turn events to the turn and trace lines to the feed', async () => {
  const compiled = compilePlayground(createExampleDraft());
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const record = recordFor({ [PLAYGROUND_RUN_METADATA_KEY]: 'run' });
  const text: TurnEvent = { type: 'text', text: 'hi' };
  const body = [text, { type: 'trace', record }]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join('');
  const transport = createPlaygroundTransport(compiled, {
    fetch: () => Promise.resolve(new Response(body)),
  });
  const events: TurnEvent[] = [];
  await transport.turn({ input: { text: 'hello' } }, (event) => events.push(event));
  assertEquals(events, [text]);
  assertEquals(transport.traces?.records(), [record]);
});

Deno.test('a Live trace envelope carries one record', () => {
  const record = recordFor(undefined);
  assertEquals(parseLiveServerEnvelope({ type: 'trace', record }), { type: 'trace', record });
  assertEquals(parseLiveServerEnvelope({ type: 'trace', record: { spans: 'none' } }), null);
  assertEquals(parseLiveServerEnvelope({ type: 'trace' }), null);
});
