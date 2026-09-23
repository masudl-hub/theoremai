/**
 * Span builder: nesting, trace context, links, clocks, and closing what was left open.
 */
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import {
  formatTraceparent,
  parseTraceparent,
  startTrace,
  type TraceClock,
  traceJson,
} from '../../src/observability/trace-span.ts';

const PARENT_TRACE = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN = 'b7ad6b7169203331';

/** A clock the test moves by hand, in nanoseconds. */
function manualClock(start = 1_000n): TraceClock & { advance: (nanos: bigint) => void } {
  let now = start;
  return {
    nowUnixNano: () => now,
    advance: (nanos) => {
      now += nanos;
    },
  };
}

Deno.test('children share the root trace and name their parent', () => {
  const tree = startTrace('invoke_agent chat', { clock: manualClock() });
  const call = tree.root.child('chat model', { kind: 'CLIENT' });
  const post = call.child('POST');
  post.end();
  call.end();
  tree.root.end();
  const [root, callSpan, postSpan] = tree.collect();
  assertEquals(root?.parentSpanId, undefined);
  assertEquals(callSpan?.traceId, root?.traceId);
  assertEquals(callSpan?.parentSpanId, root?.spanId);
  assertEquals(callSpan?.kind, 'CLIENT');
  assertEquals(postSpan?.parentSpanId, callSpan?.spanId);
  assertEquals(postSpan?.kind, 'INTERNAL');
});

Deno.test('a root opened under a traceparent joins that trace', () => {
  const tree = startTrace('cutout', {
    clock: manualClock(),
    traceparent: formatTraceparent(PARENT_TRACE, PARENT_SPAN),
  });
  tree.root.end();
  const [root] = tree.collect();
  assertEquals(root?.traceId, PARENT_TRACE);
  assertEquals(root?.parentSpanId, PARENT_SPAN);
  assertEquals(tree.root.traceparent(), `00-${PARENT_TRACE}-${root?.spanId}-01`);
});

Deno.test('malformed or all-zero trace context throws', () => {
  assertThrows(() => parseTraceparent('not-a-traceparent'), TheoremError);
  assertThrows(
    () => parseTraceparent(formatTraceparent('0'.repeat(32), PARENT_SPAN)),
    TheoremError,
  );
  assertThrows(
    () => parseTraceparent(formatTraceparent(PARENT_TRACE, '0'.repeat(16))),
    TheoremError,
  );
  assertThrows(() => startTrace('x', { links: [{ traceparent: 'bad' }] }), TheoremError);
});

Deno.test('links carry the linked span and their attributes', () => {
  const tree = startTrace('invoke_agent chat', {
    clock: manualClock(),
    links: [
      {
        traceparent: formatTraceparent(PARENT_TRACE, PARENT_SPAN),
        attributes: { 'theorem.link.kind': 'resume' },
      },
    ],
  });
  tree.root.end();
  assertEquals(tree.collect()[0]?.links, [
    { traceId: PARENT_TRACE, spanId: PARENT_SPAN, attributes: { 'theorem.link.kind': 'resume' } },
  ]);
});

Deno.test('timestamps follow the trace clock and an explicit start', () => {
  const clock = manualClock(5_000_000n);
  const tree = startTrace('root', { clock });
  const late = tree.root.child('measured', { startTimeUnixNano: '1000000' });
  clock.advance(2_000_000n);
  tree.root.event('tick', { n: 1 });
  late.end();
  assertEquals(tree.root.msSinceStart(), 2);
  assertEquals(tree.root.msSinceEnd(), undefined);
  tree.root.end();
  clock.advance(3_000_000n);
  assertEquals(tree.root.msSinceEnd(), 3);
  const [root, measured] = tree.collect();
  assertEquals(root?.startTimeUnixNano, '5000000');
  assertEquals(root?.endTimeUnixNano, '7000000');
  assertEquals(root?.events, [{ name: 'tick', timeUnixNano: '7000000', attributes: { n: 1 } }]);
  assertEquals(measured?.startTimeUnixNano, '1000000');
  assertEquals(measured?.endTimeUnixNano, '7000000');
});

Deno.test('a closed span ignores later writes and a second end', () => {
  const tree = startTrace('root', { clock: manualClock(), attributes: { a: 1 } });
  tree.root.set({ b: 2 });
  tree.root.end({ code: 'ERROR', message: 'first' });
  tree.root.set({ c: 3 });
  tree.root.event('late');
  tree.root.end({ code: 'OK' });
  const [root] = tree.collect();
  assertEquals(tree.root.ended, true);
  assertEquals(root?.attributes, { a: 1, b: 2 });
  assertEquals(root?.events, []);
  assertEquals(root?.status, { code: 'ERROR', message: 'first' });
});

Deno.test('collect closes spans left open as unclosed errors, root first', () => {
  const clock = manualClock();
  const tree = startTrace('root', { clock });
  const done = tree.root.child('done');
  const open = tree.root.child('open');
  done.end();
  clock.advance(10n);
  const spans = tree.collect();
  assertEquals(
    spans.map((s) => [s.name, s.status]),
    [
      ['root', { code: 'ERROR', message: 'unclosed' }],
      ['done', { code: 'OK' }],
      ['open', { code: 'ERROR', message: 'unclosed' }],
    ],
  );
  assertEquals(open.ended, true);
  assertEquals(spans[2]?.endTimeUnixNano, '1010');
});

Deno.test('traceJson keeps what JSON keeps', () => {
  assertEquals(traceJson({ a: 1, b: undefined, c: [undefined, Number.NaN], d: () => 1 }), {
    $json: { a: 1, c: [null, null] },
  });
  assertEquals(traceJson(undefined), { $json: null });
});
