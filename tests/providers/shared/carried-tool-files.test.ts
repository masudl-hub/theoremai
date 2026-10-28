import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import type { InteractionPart, TurnHistoryMessage } from '../../../src/kernel/types.ts';
import {
  withCarriedAssistantFiles,
  withCarriedToolFiles,
} from '../../../src/providers/shared/carried-tool-files.ts';

const TEXT_ONLY: ReadonlySet<InteractionPart['type']> = new Set(['text']);
const PDF: InteractionPart = { type: 'document', mimeType: 'application/pdf', data: 'JVBERi0=' };
const PHOTO: InteractionPart = { type: 'image', mimeType: 'image/png', data: 'iVBORw0=' };

Deno.test('history whose tool results hold every part is returned as it came', () => {
  const history: TurnHistoryMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'tool', name: 'read', tool_call_id: 'c1', content: 'ok', parts: [PHOTO] },
  ];
  assertEquals(withCarriedToolFiles(history, new Set(['text', 'image'])), history);
});

Deno.test('a file a tool result cannot hold leaves a marker and follows in a user message', () => {
  const out = withCarriedToolFiles(
    [
      {
        role: 'tool',
        name: 'recall_message',
        tool_call_id: 'c1',
        content: 'Completed.',
        parts: [{ type: 'text', text: 'media.1' }, PDF],
      },
      { role: 'assistant', content: 'Opened.' },
    ],
    TEXT_ONLY,
  );
  assertEquals(out, [
    {
      role: 'tool',
      name: 'recall_message',
      tool_call_id: 'c1',
      content: 'Completed.',
      parts: [
        { type: 'text', text: 'media.1' },
        { type: 'text', text: '[document: sent in the next message]' },
      ],
    },
    { role: 'user', parts: [{ type: 'text', text: 'Files from the recall_message result:' }, PDF] },
    { role: 'assistant', content: 'Opened.' },
  ]);
});

Deno.test('the files of a run of tool results follow the whole run, each led by its tool', () => {
  const out = withCarriedToolFiles(
    [
      { role: 'tool', name: 'read_a', tool_call_id: 'c1', parts: [PDF] },
      { role: 'tool', name: 'read_b', tool_call_id: 'c2', content: 'no file' },
      { role: 'tool', tool_call_id: 'c3', parts: [PHOTO] },
    ],
    TEXT_ONLY,
  );
  assertEquals(
    out.map((msg) => msg.role),
    ['tool', 'tool', 'tool', 'user'],
  );
  assertEquals(out[3]?.parts, [
    { type: 'text', text: 'Files from the read_a result:' },
    PDF,
    { type: 'text', text: 'Files from a tool result:' },
    PHOTO,
  ]);
});

Deno.test("an assistant message's files follow it in a user message", () => {
  assertEquals(
    withCarriedAssistantFiles([
      { role: 'assistant', content: 'Here is your plant.', parts: [PHOTO] },
      { role: 'user', content: 'thanks' },
    ]),
    [
      {
        role: 'assistant',
        content: 'Here is your plant.',
        parts: [{ type: 'text', text: '[image: sent in the next message]' }],
      },
      { role: 'user', parts: [{ type: 'text', text: 'Files the assistant sent:' }, PHOTO] },
      { role: 'user', content: 'thanks' },
    ],
  );
});

Deno.test("an assistant message's files follow the results of the calls it made", () => {
  const call = { id: 'c1', type: 'function' as const, function: { name: 'read', arguments: '{}' } };
  assertEquals(
    withCarriedAssistantFiles([
      { role: 'assistant', parts: [PHOTO], tool_calls: [call] },
      { role: 'tool', name: 'read', tool_call_id: 'c1', content: 'ok' },
    ]),
    [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: '[image: sent in the next message]' }],
        tool_calls: [call],
      },
      { role: 'tool', name: 'read', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', parts: [{ type: 'text', text: 'Files the assistant sent:' }, PHOTO] },
    ],
  );
});

Deno.test('assistant messages with only text are returned as they came', () => {
  const history: TurnHistoryMessage[] = [
    { role: 'assistant', content: 'hi', parts: [{ type: 'text', text: 'more' }] },
  ];
  assertEquals(withCarriedAssistantFiles(history), history);
});
