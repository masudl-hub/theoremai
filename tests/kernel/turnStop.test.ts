import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  AUTO_CONTINUE_DELAY_MS,
  CONTINUE_INSTRUCTION,
  GenerationStopError,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
  turnStopFromInteractionStatus,
  turnStopFromOpenAiFinishReason,
} from '../../src/kernel/stop.ts';

Deno.test('turnStopFromOpenAiFinishReason maps normalized reasons', () => {
  assertEquals(turnStopFromOpenAiFinishReason('stop').kind, 'completed');
  assertEquals(turnStopFromOpenAiFinishReason('length').kind, 'length');
  assertEquals(turnStopFromOpenAiFinishReason('error').kind, 'provider_error');
  assertEquals(turnStopFromOpenAiFinishReason('stop', 'network_error').kind, 'provider_error');
  assertEquals(turnStopFromOpenAiFinishReason('tool_calls').kind, 'tool');
  assertEquals(turnStopFromOpenAiFinishReason('content_filter').kind, 'filtered');
});

Deno.test('turnStopFromInteractionStatus maps terminal statuses', () => {
  assertEquals(turnStopFromInteractionStatus('completed').kind, 'completed');
  assertEquals(turnStopFromInteractionStatus('incomplete').kind, 'length');
  assertEquals(turnStopFromInteractionStatus('budget_exceeded').kind, 'length');
  assertEquals(turnStopFromInteractionStatus('cancelled').kind, 'cancelled');
  assertEquals(turnStopFromInteractionStatus('failed').kind, 'provider_error');
  assertEquals(turnStopFromInteractionStatus('requires_action').kind, 'tool');
});

Deno.test('turnStopFromClientStreamEnd', () => {
  assertEquals(
    turnStopFromClientStreamEnd({ abortedByUser: true, sawTerminal: false })?.kind,
    'cancelled',
  );
  assertEquals(
    turnStopFromClientStreamEnd({ abortedByUser: false, sawTerminal: false })?.kind,
    'stream_incomplete',
  );
  assertEquals(turnStopFromClientStreamEnd({ abortedByUser: false, sawTerminal: true }), null);
});

Deno.test('resume policy helpers', () => {
  assertEquals(isResumeableStop({ kind: 'stream_incomplete' }), true);
  assertEquals(isUserCancelledStop({ kind: 'cancelled' }), true);
  assertEquals(isResumeableStop({ kind: 'cancelled' }), false);
  assertEquals(shouldAutoContinue({ kind: 'length' }), true);
  assertEquals(shouldAutoContinue({ kind: 'stream_incomplete' }), true);
  assertEquals(shouldAutoContinue({ kind: 'cancelled' }), false);
  assertEquals(shouldAutoContinue({ kind: 'length' }, []), false);
  assertEquals(CONTINUE_INSTRUCTION.length > 20, true);
  assertEquals(AUTO_CONTINUE_DELAY_MS, 1_500);
});

Deno.test('GenerationStopError', () => {
  const err = new GenerationStopError({ kind: 'stream_incomplete', native: 'missing_final' });
  assertEquals(isGenerationStopError(err), true);
  assertEquals(err.stop.kind, 'stream_incomplete');
});
