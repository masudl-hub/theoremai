import { assertEquals } from '@std/assert';
import { createEventLog, EVENTS_KEPT, failureIn, watchRun } from '../../studio/server/events.ts';

const AT = new Date('2026-10-27T10:00:00Z');

Deno.test('the log keeps the last events, and counts one that repeats the last', () => {
  const log = createEventLog(() => AT);
  assertEquals(log.add('run', 'run a failed: boom'), true);
  assertEquals(log.add('run', 'run a failed: boom'), false);
  assertEquals(log.list(), [
    { at: AT.toISOString(), kind: 'run', text: 'run a failed: boom', repeated: 2 },
  ]);
  for (let at = 0; at <= EVENTS_KEPT; at += 1) log.add('page', `error ${at}`);
  assertEquals(log.list().length, EVENTS_KEPT);
  assertEquals(log.list()[0]?.text, 'error 1');
});

Deno.test('a follower reads the kept events, then each new one', async () => {
  const log = createEventLog(() => AT);
  log.add('key', 'key for gemini is empty');
  const reader = log.follow({}).body?.pipeThrough(new TextDecoderStream()).getReader();
  log.add('run', 'run a failed: boom');
  let read = '';
  while (!read.includes('boom')) read += (await reader?.read())?.value ?? '';
  await reader?.cancel();
  const said = read
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)).text);
  assertEquals(said, ['key for gemini is empty', 'run a failed: boom']);
});

Deno.test("a run's failure is its error event's detail, else its wording, else its kind", () => {
  assertEquals(
    failureIn(
      '{"type":"error","errorKind":"auth","error":"Sign in","errorInternal":"401 bad key"}',
    ),
    '401 bad key',
  );
  assertEquals(failureIn('{"type":"error","errorKind":"auth","error":"Sign in"}'), 'Sign in');
  assertEquals(failureIn('{"type":"error","errorKind":"auth"}'), 'auth');
  assertEquals(failureIn('{"type":"text","text":"error"}'), undefined);
  assertEquals(failureIn('not json'), undefined);
});

Deno.test('a watched run reaches the page unchanged, and each failure in it is told', async () => {
  const failed: string[] = [];
  const lines = ['{"type":"text","text":"Hi"}', '{"type":"error","errorKind":"timeout"}', ''];
  const response = watchRun(
    new Response(lines.join('\n'), { headers: { 'content-type': 'application/x-ndjson' } }),
    (said) => failed.push(said),
  );
  assertEquals(await response.text(), lines.join('\n'));
  assertEquals(failed, ['timeout']);
  const refused = watchRun(new Response('{"message":"no"}', { status: 400 }), (said) =>
    failed.push(said),
  );
  assertEquals(refused.status, 400);
  await refused.text();
  await new Promise((settle) => setTimeout(settle, 0));
  assertEquals(failed.at(-1), 'answered 400: {"message":"no"}');
});
