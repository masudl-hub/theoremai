import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import {
  createOwnInbox,
  openRun,
  personMessageOf,
  scopedStop,
  steerRun,
  theoremSteerRequestSchema,
} from '../../web/src/server/mod.ts';

Deno.test('a steer body keeps the trimmed id, and its message is one user message', () => {
  const body = theoremSteerRequestSchema.parse({
    turnId: ' turn-1 ',
    id: ' steer-1 ',
    input: { text: 'steered' },
  });
  assertEquals('turnId' in body ? body.turnId : undefined, 'turn-1');
  assertEquals(personMessageOf(body), {
    id: 'steer-1',
    kind: 'person_message',
    handovers: [],
    messages: [{ role: 'user', content: 'steered' }],
  });
});

Deno.test("a steer's files go to the model beside its text", () => {
  const photo = { name: 'leaf.png', mimeType: 'image/png', data: 'aGk=' };
  assertEquals(
    personMessageOf({ id: 'steer-1', input: { text: 'this one', attachments: [photo] } }),
    {
      id: 'steer-1',
      kind: 'person_message',
      handovers: [],
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'image', mimeType: 'image/png', data: 'aGk=' },
            { type: 'text', text: 'this one' },
          ],
        },
      ],
    },
  );
});

Deno.test('a steer without a turn or a conversation, an id, or a message fails its check', () => {
  const input = { text: 'steered' };
  // Each body fails both forms: to a turn by its id, and to the reply that holds a conversation.
  // A body that only one form could have been fails with that form's reason alone.
  const refused: [unknown, string[]][] = [
    [{ turnId: 't', input }, ['id', 'id']],
    [{ turnId: 't', id: '  ', input }, ['id']],
    [{ turnId: 't', id: 7, input }, ['id', 'id']],
    [{ id: 'steer-1', input }, ['turnId', 'conversation']],
    [{ turnId: 't', id: 'steer-1' }, ['input', 'input']],
    [{ turnId: 't', id: 'steer-1', input: 'steered' }, ['input', 'input']],
  ];
  for (const [body, paths] of refused) {
    const parsed = theoremSteerRequestSchema.safeParse(body);
    assertEquals(parsed.success, false);
    if (parsed.success) continue;
    const [issue] = parsed.error.issues;
    const reasons =
      issue?.code === 'invalid_union'
        ? issue.errors.map((form) => form[0]?.path[0])
        : [issue?.path[0]];
    assertEquals(reasons, paths);
  }
});

Deno.test('a steer with no text and no file is refused', () => {
  assertThrows(
    () => personMessageOf({ id: 'steer-1', input: { text: '  ' } }),
    TheoremError,
    'a steer needs text or a file',
  );
});

Deno.test('a steer reaches a run while it is open, and no run after it closes', async () => {
  const own = createOwnInbox();
  const message = personMessageOf({ id: 'steer-1', input: { text: 'first' } });
  assertEquals(steerRun(own, 's-1', 'turn-1', message), false);
  const run = openRun(own, 's-1', 'turn-1', 60_000);
  assertEquals(steerRun(own, 's-2', 'turn-1', message), false, "another session's run");
  assertEquals(steerRun(own, 's-1', 'turn-1', message), true);
  assertEquals(
    (await run.memory.read('turn-1')).items.map((item) => item.id),
    ['steer-1'],
  );
  run.close();
  assertEquals(steerRun(own, 's-1', 'turn-1', message), false);
});

Deno.test('a stop reaches the run that holds the name, scoped to its session', async () => {
  const own = createOwnInbox();
  const mine = scopedStop(own.stop, 's-1');
  const theirs = scopedStop(own.stop, 's-2');
  assertEquals(await mine.ask('turn-1'), false);
  const waiting = mine.stopped('turn-1', 'hold-1', new AbortController().signal);
  assertEquals(await theirs.ask('turn-1'), false, "another session's stop");
  assertEquals(await mine.ask('turn-1'), true);
  assertEquals(await waiting, true);
  assertEquals(await mine.stopped('turn-1', 'hold-1', new AbortController().signal), true);
  await mine.clear('turn-1', 'hold-1');
  assertEquals(await mine.ask('turn-1'), false);
});

Deno.test('a stop that asks as its hold closes is not stopped', async () => {
  const own = createOwnInbox();
  const stop = scopedStop(own.stop, 's-1');
  const waiting = stop.stopped('turn-2', 'hold-2', new AbortController().signal);
  await stop.clear('turn-2', 'hold-2');
  assertEquals(await waiting, false);
  assertEquals(await stop.ask('turn-2'), false);
});
