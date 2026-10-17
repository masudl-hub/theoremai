import { assertEquals } from '@std/assert';
import {
  type StreamingToolCall,
  toolDraftEvents,
} from '../../../src/providers/shared/tool-draft.ts';

Deno.test('toolDraftEvents waits for an id and a name, then sends what came before', () => {
  const call: StreamingToolCall = { name: '', args: '{"a":' };
  assertEquals(toolDraftEvents(call), []);
  call.name = 'write';
  assertEquals(toolDraftEvents(call), []);
  call.id = 'c1';
  assertEquals(toolDraftEvents(call), [
    { type: 'tool_draft', callId: 'c1', name: 'write', text: '{"a":' },
  ]);
});

Deno.test('toolDraftEvents sends each piece once, and nothing when nothing came', () => {
  const call: StreamingToolCall = { id: 'c1', name: ' write ', args: '{"a":' };
  assertEquals(toolDraftEvents(call).length, 1);
  assertEquals(toolDraftEvents(call), []);
  call.args += '1}';
  assertEquals(toolDraftEvents(call), [
    { type: 'tool_draft', callId: 'c1', name: 'write', text: '1}' },
  ]);
  assertEquals(call.drafted, call.args.length);
});
