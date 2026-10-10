import { assertEquals } from '@std/assert';
import { parseLiveServerEnvelope } from '../../react/src/client/live-messages.ts';
import { createTraceFeed } from '../../react/src/client/trace-feed.ts';
import type { ClientTurnEvent } from '../../react/src/client/transport.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import {
  compileStudio,
  createExampleDraft,
  createStudioTraceRouter,
  createStudioTransport,
  STUDIO_RUN_METADATA_KEY,
} from '../../studio/mod.ts';
import { assertMalformed } from '../fixtures/malformed.ts';
import { STUB_WRITE, stubRecord, stubSpan } from '../fixtures/trace-record.ts';

function recordFor(metadata: Record<string, unknown> | undefined): TraceRecord {
  return { ...stubRecord(), ...(metadata ? { metadata } : {}), spans: [stubSpan()] };
}

Deno.test('the trace router hands each record to the run that wrote it, while its route is open', async () => {
  const router = createStudioTraceRouter();
  const first: TraceRecord[] = [];
  const second: TraceRecord[] = [];
  const a = router.route((record) => first.push(record));
  const b = router.route((record) => second.push(record));
  assertEquals(a.metadata[STUDIO_RUN_METADATA_KEY] === b.metadata[STUDIO_RUN_METADATA_KEY], false);

  const forA = recordFor({ ...a.metadata, host: 'kept' });
  await router.sink.write(forA, STUB_WRITE);
  await router.sink.write(recordFor(b.metadata), STUB_WRITE);
  await router.sink.write(recordFor(undefined), STUB_WRITE);
  await router.sink.write(recordFor({ [STUDIO_RUN_METADATA_KEY]: 'unknown' }), STUB_WRITE);
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

Deno.test('a studio run stream sends turn events to the turn and trace lines to the feed', async () => {
  const compiled = compileStudio(createExampleDraft());
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const record = recordFor({ [STUDIO_RUN_METADATA_KEY]: 'run' });
  const text: TurnEvent = { type: 'text', text: 'hi' };
  const body = [text, { type: 'trace', record }]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join('');
  const transport = createStudioTransport(compiled, {
    fetch: () => Promise.resolve(new Response(body)),
  });
  const events: ClientTurnEvent[] = [];
  await transport.turn({ input: { text: 'hello' } }, (event) => events.push(event));
  assertEquals(events, [text]);
  assertEquals(transport.traces?.records(), [record]);
});

Deno.test('a Live trace envelope carries one record', () => {
  const record = recordFor(undefined);
  assertEquals(parseLiveServerEnvelope(JSON.stringify({ type: 'trace', record })), {
    type: 'trace',
    record,
  });
  // A trace envelope without its record, or with one that fails its schema, is malformed.
  for (const raw of [{ type: 'trace', record: { spans: 'none' } }, { type: 'trace' }]) {
    assertMalformed(parseLiveServerEnvelope(JSON.stringify(raw)));
  }
});
