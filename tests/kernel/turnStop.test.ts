import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  AUTO_CONTINUE_DELAY_MS,
  GenerationStopError,
  isContinueStopKind,
  isFailedStopKind,
  isFailedTurnStop,
  isGenerationStopError,
  isResumeableStop,
  isUserCancelledStop,
  profileAllowsSteering,
  profileTurnResumption,
  shouldAutoContinue,
  turnStopFromClientStreamEnd,
} from '../../src/kernel/stop.ts';

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
  assertEquals(isResumeableStop({ kind: 'completed' }), false);
  assertEquals(isResumeableStop({ kind: 'tool' }), false);
  assertEquals(isResumeableStop({ kind: 'filtered' }), false);
  assertEquals(isContinueStopKind('length'), true);
  assertEquals(isContinueStopKind('cancelled'), false);
  assertEquals(shouldAutoContinue({ kind: 'length' }), true);
  assertEquals(shouldAutoContinue({ kind: 'stream_incomplete' }), true);
  assertEquals(shouldAutoContinue({ kind: 'cancelled' }), false);
  assertEquals(shouldAutoContinue({ kind: 'length' }, { autoContinue: [] }), false);
  assertEquals(
    shouldAutoContinue({ kind: 'provider_error' }, { autoContinue: ['provider_error'] }),
    true,
  );
  // Offering Continue and continuing on its own are picked apart: neither list reads the other.
  const unoffered = { allowContinue: [], autoContinue: ['provider_error' as const] };
  assertEquals(shouldAutoContinue({ kind: 'provider_error' }, unoffered), true);
  for (const kind of ['length', 'stream_incomplete', 'provider_error'] as const) {
    assertEquals(isResumeableStop({ kind }, []), false);
    assertEquals(shouldAutoContinue({ kind }, { autoContinue: [] }), false);
  }
  assertEquals(AUTO_CONTINUE_DELAY_MS, 1_500);
});

Deno.test('turnBehaviour helpers', () => {
  assertEquals(
    profileTurnResumption({
      type: 'text',
      turnBehaviour: { resumption: { maxContinues: 2 } },
    })?.maxContinues,
    2,
  );
  assertEquals(profileTurnResumption({ type: 'live' }), undefined);
  assertEquals(profileAllowsSteering({ type: 'text' }), true);
  assertEquals(
    profileAllowsSteering({ type: 'text', turnBehaviour: { allowSteering: false } }),
    false,
  );
  assertEquals(
    profileAllowsSteering({ type: 'image', turnBehaviour: { allowSteering: true } }),
    false,
  );
});

Deno.test('GenerationStopError', () => {
  const err = new GenerationStopError({ kind: 'stream_incomplete', native: 'missing_final' });
  assertEquals(isGenerationStopError(err), true);
  assertEquals(err.stop.kind, 'stream_incomplete');
});

Deno.test('a missing answer is a failed turn, not a failed call, and offers Continue', () => {
  assertEquals(isFailedStopKind('answer_missing'), false);
  assertEquals(isFailedTurnStop('answer_missing'), true);
  assertEquals(isFailedTurnStop('provider_error'), true);
  assertEquals(isFailedTurnStop('completed'), false);
  assertEquals(isResumeableStop({ kind: 'answer_missing' }), true);
  assertEquals(isResumeableStop({ kind: 'answer_missing' }, ['provider_error']), false);
  assertEquals(shouldAutoContinue({ kind: 'answer_missing' }), false);
  assertEquals(
    shouldAutoContinue({ kind: 'answer_missing' }, { autoContinue: ['answer_missing'] }),
    true,
  );
});
