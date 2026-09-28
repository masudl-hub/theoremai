import '../../../fixtures/test-host.ts';
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import {
  finalizeStructured,
  isVoiceProfile,
  missingSpeechAudioError,
  newStreamFold,
  shouldReportMissingSpeechAudio,
} from '../../../../src/providers/google/interactions/stream.ts';
import { resolvedStructured, stubCompleteRequest } from '../../../fixtures/provider-request.ts';

Deno.test('F-04 pressure: missing-audio gate matrix', () => {
  const voice = stubCompleteRequest({ speech: { voice: 'Kore', format: 'pcm' } });
  const plain = stubCompleteRequest({ speech: undefined });
  const empty = newStreamFold();
  const text = newStreamFold();
  text.text = 'hi';
  const media = newStreamFold();
  media.text = 'hi';
  media.sawMedia = true;

  assertEquals(isVoiceProfile(voice), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, text), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, empty), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, media), false);
  assertEquals(shouldReportMissingSpeechAudio(plain, text), false);

  const [err] = [...missingSpeechAudioError()];
  assertEquals(
    err?.type === 'error' ? err.errorInternal : undefined,
    'speech audio was not returned by the model',
  );
});

Deno.test('structured-required + bad JSON emits error (never silent skip)', () => {
  const fold = newStreamFold();
  fold.text = 'not json';
  const req = stubCompleteRequest({ structured: resolvedStructured('chatTurn') });
  const events = [...finalizeStructured(req, fold)];
  assertEquals(events, [
    {
      type: 'error',
      errorKind: 'bad_response',
      errorInternal: 'structured output was not valid JSON',
    },
  ]);

  fold.text = '{"ok":true}';
  assertEquals(
    [...finalizeStructured(req, fold)],
    [{ type: 'structured', structured: { ok: true } }],
  );
});
