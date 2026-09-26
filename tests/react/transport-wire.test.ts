import { assertEquals, assertRejects } from '@std/assert';
import { TheoremError, TURN_EVENT_SCHEMAS, z } from '../../mod.ts';
import {
  type ClientTurnEvent,
  createHttpTransport,
  postNdjson,
  TheoremStreamError,
} from '../../react/src/client/transport.ts';
import type { UnsupportedEvent, WireLines } from '../../react/src/client/wire-line.ts';

/** A host that answers every request with `body` at `status`. */
function transportReplying(body: string, status = 200) {
  return createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: () => Promise.resolve(new Response(body, { status })),
  });
}

const ndjson = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n');

async function turnLines(body: string, status = 200): Promise<ClientTurnEvent[]> {
  const events: ClientTurnEvent[] = [];
  await transportReplying(body, status).turn({ input: { text: 'hi' } }, (event) =>
    events.push(event),
  );
  return events;
}

async function assertBadResponse(run: () => Promise<unknown>, message: string): Promise<void> {
  const err = await assertRejects(run, TheoremError);
  assertEquals(err.kind, 'bad_response');
  assertEquals(err.message, message);
}

Deno.test('a line of a kind the client does not know arrives as unsupported, and the turn goes on', async () => {
  const future = { type: 'hologram', beam: 1 };
  const text: ClientTurnEvent = { type: 'text', text: 'hello' };
  assertEquals(await turnLines(ndjson(future, text)), [
    { type: 'unsupported', received: 'hologram', raw: future },
    text,
  ]);
});

Deno.test('a known line that fails its schema ends the turn with bad_response, naming only paths and codes, branch by branch', async () => {
  await assertBadResponse(
    () => turnLines(ndjson({ type: 'text', text: 7 })),
    "a 'text' line failed its wire check: text invalid_type",
  );
  await assertBadResponse(
    () => turnLines(ndjson({ type: 'tool', tool: { phase: 'running', callId: 7 } })),
    "a 'tool' line failed its wire check: tool invalid_union [" +
      'tool.name invalid_type; tool.callId invalid_type; tool.at invalid_type | ' +
      'tool.name invalid_type; tool.callId invalid_type; tool.phase invalid_type; tool.arguments invalid_type]',
  );
  await assertBadResponse(
    () => turnLines(ndjson({ text: 'no kind' })),
    'a line without a kind failed its wire check: type invalid_type',
  );
  await assertBadResponse(() => turnLines('{not json'), 'a line is not JSON');
});

Deno.test("a host's own line kinds parse only when the host supplies them", async () => {
  type Mark = { type: 'mark'; at: number };
  const markLines: WireLines<Mark> = {
    mark: z.object({ type: z.literal('mark'), at: z.number() }),
  };
  const lines: (Mark | UnsupportedEvent)[] = [];
  await postNdjson('http://host.test/x', {}, markLines, (line) => lines.push(line), {
    fetch: () => Promise.resolve(new Response(ndjson({ type: 'mark', at: 3 }))),
  });
  assertEquals(lines, [{ type: 'mark', at: 3 }]);
  assertEquals(await turnLines(ndjson({ type: 'mark', at: 3 })), [
    { type: 'unsupported', received: 'mark', raw: { type: 'mark', at: 3 } },
  ]);
  await assertRejects(
    () =>
      postNdjson('http://host.test/x', {}, TURN_EVENT_SCHEMAS, () => {}, {
        fetch: () => Promise.resolve(new Response(ndjson({ type: 'text', text: 7 }))),
      }),
    TheoremError,
  );
});

Deno.test('a host error body is read by its schema; one that fails it is bad_response', async () => {
  const refused = await assertRejects(
    () => turnLines(JSON.stringify({ error: 'Try again.', errorKind: 'rate_limit' }), 429),
    TheoremStreamError,
  );
  assertEquals([refused.kind, refused.publicMessage], ['rate_limit', 'Try again.']);
  await assertBadResponse(
    () => turnLines(JSON.stringify({ errorKind: 'not-a-kind' }), 500),
    'HTTP 500 error body failed its wire check',
  );
});
