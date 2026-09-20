import { assertEquals } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  caughtStatus,
  flushMintTrace,
  HTTP_BUSY,
  HTTP_METHOD,
  HTTP_NOT_FOUND,
  HTTP_OK,
  json,
} from '../../src/host/mod.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';

function stubRecord(): TraceRecord {
  return {
    v: 1,
    id: 'x',
    ts: Date.now() - 5,
    ms: 1,
    streamed: true,
    cancelled: false,
    previousInteractionId: null,
    store: false,
    profile: 'chat',
    input: { attachments: [], voice: [] },
    events: [],
    ok: true,
  };
}

Deno.test('host reply helpers map status codes and JSON bodies', async () => {
  const res = json(HTTP_OK, { ok: true }, { 'Access-Control-Allow-Origin': '*' });
  assertEquals(res.status, HTTP_OK);
  assertEquals(await res.json(), { ok: true });
  assertEquals(caughtStatus(new TheoremError('bad request')), 400);
  assertEquals(caughtStatus(new Error('boom')), 500);
  assertEquals(HTTP_BUSY, 429);
  assertEquals(HTTP_METHOD, 405);
  assertEquals(HTTP_NOT_FOUND, 404);
});

Deno.test('flushMintTrace attaches cutout metadata onto a held trace row', async () => {
  const into: TraceRecord[] = [];
  const held = [stubRecord()];

  await flushMintTrace({
    held,
    app: { route: 'vinylator' },
    cutout: { ok: false, ms: 12, error: 'cutout failed' },
    sink: memorySink(into),
  });

  assertEquals(into.length, 1);
  assertEquals(into[0]?.ok, false);
  assertEquals(into[0]?.error, 'cutout failed');
  assertEquals(into[0]?.app, { route: 'vinylator' });
});
