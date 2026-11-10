import { assertEquals } from '@std/assert';
import { turnStopFromInteractionStatus } from '../../../../src/providers/google/interactions/status.ts';

Deno.test('turnStopFromInteractionStatus maps terminal statuses', () => {
  assertEquals(turnStopFromInteractionStatus('completed').kind, 'completed');
  assertEquals(turnStopFromInteractionStatus('incomplete').kind, 'length');
  assertEquals(turnStopFromInteractionStatus('budget_exceeded').kind, 'length');
  assertEquals(turnStopFromInteractionStatus('cancelled').kind, 'cancelled');
  assertEquals(turnStopFromInteractionStatus('failed').kind, 'provider_error');
  assertEquals(turnStopFromInteractionStatus('requires_action').kind, 'tool');
});
