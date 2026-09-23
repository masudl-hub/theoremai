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
import { resolveObservabilityPolicy } from '../../src/observability/resolve-policy.ts';
import { memorySink } from '../../src/observability/trace.ts';
import { buildRecord, contentOf, type TraceRecord } from '../../src/observability/trace-record.ts';
import { startTrace } from '../../src/observability/trace-span.ts';

const CUTOUT_MS = 12;
const NANOS_PER_MS = 1_000_000n;

async function heldTurn(): Promise<TraceRecord> {
  const tree = startTrace('invoke_agent chat', { attributes: { 'gen_ai.agent.name': 'chat' } });
  tree.root.end();
  return await buildRecord({
    spans: tree.collect(),
    policy: resolveObservabilityPolicy(undefined),
    metadata: { user: 'u1' },
  });
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

Deno.test('flushMintTrace writes the held turn, then a cutout span under its root', async () => {
  const into: TraceRecord[] = [];
  const turn = await heldTurn();

  await flushMintTrace({
    held: [turn],
    app: { route: 'vinylator' },
    cutout: {
      ok: false,
      ms: CUTOUT_MS,
      url: 'https://cutout.example/v1/cut?key=secret',
      http: { status: 502 },
      error: 'cutout failed',
    },
    sink: memorySink(into),
  });

  const [first, second] = into;
  assertEquals(first, turn);
  const [span] = second?.spans ?? [];
  const [root] = turn.spans;
  assertEquals(span?.name, 'cutout');
  assertEquals(span?.traceId, root?.traceId);
  assertEquals(span?.parentSpanId, root?.spanId);
  assertEquals(span?.status, { code: 'ERROR' });
  assertEquals(span?.attributes['url.path'], '/v1/cut');
  assertEquals(
    span?.events.map((e) => e.name),
    ['theorem.upstream.row', 'exception'],
  );
  const failure = span?.events[1]?.attributes['exception.message'];
  assertEquals(second && contentOf(second, failure), 'cutout failed');
  assertEquals(
    BigInt(span?.endTimeUnixNano ?? 0) - BigInt(span?.startTimeUnixNano ?? 0),
    BigInt(CUTOUT_MS) * NANOS_PER_MS,
  );
  assertEquals(second?.metadata, { user: 'u1', app: { route: 'vinylator' } });
});
