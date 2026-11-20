import { assertEquals } from '@std/assert';
import {
  blockWithoutToolData,
  eventWithoutToolData,
  type TranscriptBlock,
} from '../../src/interface/mod.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

const CALL = { name: 'delete_photo', callId: 'c1', at: 1 } as const;

function tool(phase: Extract<TurnEvent, { type: 'tool' }>['tool']): TurnEvent {
  return { type: 'tool', tool: phase };
}

Deno.test('a call the model makes reaches the person with no arguments', () => {
  const made = tool({ name: 'delete_photo', callId: 'c1', arguments: { photo: 'fern.jpg' } });
  assertEquals(
    eventWithoutToolData(made),
    tool({ name: 'delete_photo', callId: 'c1', arguments: {} }),
  );
});

Deno.test("a call's data phases, its draft, and late results reach the person as nothing", () => {
  const dataOnly: TurnEvent[] = [
    tool({ ...CALL, phase: 'progress', data: { rows: 3 } }),
    tool({ ...CALL, phase: 'draft', text: 'Deleting fern' }),
    tool({
      ...CALL,
      phase: 'trace',
      step: { kind: 'http', name: 'storage', status: 'ok', inputs: { photo: 'fern.jpg' } },
    }),
    { type: 'tool_draft', callId: 'c1', name: 'delete_photo', text: '{"photo":' },
    {
      type: 'late_results',
      text: 'fern.jpg deleted',
      operationIds: ['o1'],
      stage: 'post_tool',
      step: 1,
      inReply: true,
    },
  ];
  for (const event of dataOnly) assertEquals(eventWithoutToolData(event), undefined);
});

Deno.test('a completed call keeps its label and the media it sent, not its output', () => {
  const done = tool({
    ...CALL,
    phase: 'complete',
    output: { deleted: 'fern.jpg' },
    readBack: 'deleted fern.jpg',
    activityPast: 'Deleted the photo',
    parts: [
      { type: 'text', text: 'deleted' },
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'image', mimeType: 'image/jpeg', data: 'BBBB', sent: true },
      { type: 'image', mimeType: 'image/jpeg', uri: 'media/fern.jpg' },
    ],
  });
  assertEquals(
    eventWithoutToolData(done),
    tool({
      ...CALL,
      phase: 'complete',
      output: null,
      activityPast: 'Deleted the photo',
      parts: [
        { type: 'image', mimeType: 'image/jpeg', data: 'BBBB', sent: true },
        { type: 'image', mimeType: 'image/jpeg', uri: 'media/fern.jpg' },
      ],
    }),
  );
});

Deno.test('an approval keeps its wording and loses the arguments it was prepared with', () => {
  const gated = tool({
    ...CALL,
    phase: 'gate',
    readBack: 'waiting',
    gate: {
      kind: 'confirmation',
      tool: 'delete_photo',
      request: 'delete the photo of Fern',
      preparedArguments: { photo: 'fern.jpg' },
    },
  });
  assertEquals(
    eventWithoutToolData(gated),
    tool({
      ...CALL,
      phase: 'gate',
      gate: { kind: 'confirmation', tool: 'delete_photo', request: 'delete the photo of Fern' },
    }),
  );
});

Deno.test('a call the page runs keeps its arguments, which the page needs to run it', () => {
  const dispatch = tool({
    ...CALL,
    phase: 'dispatch',
    grantId: 'g1',
    arguments: { photo: 'fern.jpg' },
  });
  assertEquals(eventWithoutToolData(dispatch), dispatch);
});

Deno.test('a saved tool call loses its arguments, edits, steps and output', () => {
  const block: TranscriptBlock = {
    id: 'b1',
    kind: 'tool',
    tool: {
      name: 'delete_photo',
      callId: 'c1',
      arguments: { photo: 'fern.jpg' },
      edited: { from: { photo: 'fern.jpg' }, to: { photo: 'fern-2.jpg' } },
      activityPast: 'Deleted the photo',
      steps: [{ name: 'find_photo', callId: 'c0', arguments: { plant: 'Fern' } }],
      state: { ...CALL, phase: 'complete', output: { deleted: 'fern-2.jpg' } },
    },
  };
  assertEquals(blockWithoutToolData(block), {
    id: 'b1',
    kind: 'tool',
    tool: {
      name: 'delete_photo',
      callId: 'c1',
      arguments: {},
      activityPast: 'Deleted the photo',
      state: { ...CALL, phase: 'complete', output: null },
    },
  });
});

Deno.test('late results leave the saved transcript; every other block stays as it is', () => {
  const late: TranscriptBlock = {
    id: 'l1',
    kind: 'late-results',
    text: 'fern.jpg deleted',
    operationIds: ['o1'],
    inReply: false,
  };
  const text: TranscriptBlock = { id: 't1', kind: 'text', text: 'Done.' };
  assertEquals(blockWithoutToolData(late), undefined);
  assertEquals(blockWithoutToolData(text), text);
});
