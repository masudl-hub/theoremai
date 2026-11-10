import { assertEquals } from '@std/assert';
import { turnStopFromOpenAiFinishReason } from '../../../src/providers/open-ai/finish-reason.ts';

Deno.test('turnStopFromOpenAiFinishReason maps normalized reasons', () => {
  assertEquals(turnStopFromOpenAiFinishReason('stop').kind, 'completed');
  assertEquals(turnStopFromOpenAiFinishReason('length').kind, 'length');
  assertEquals(turnStopFromOpenAiFinishReason('error').kind, 'provider_error');
  assertEquals(turnStopFromOpenAiFinishReason('stop', 'network_error').kind, 'provider_error');
  assertEquals(turnStopFromOpenAiFinishReason('tool_calls').kind, 'tool');
  assertEquals(turnStopFromOpenAiFinishReason('tool_calls', 'length').kind, 'length');
  assertEquals(turnStopFromOpenAiFinishReason('content_filter').kind, 'filtered');
});
