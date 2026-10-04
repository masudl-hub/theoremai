import '../../../fixtures/test-host.ts';
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import {
  finalizeStructured,
  isVoiceProfile,
  missingMediaError,
  newStreamFold,
} from '../../../../src/providers/google/interactions/stream.ts';
import { resolvedStructured, stubCompleteRequest } from '../../../fixtures/provider-request.ts';

Deno.test('F-04 pressure: missing-media gate matrix', () => {
  const voice = stubCompleteRequest({ speech: { voice: 'Kore', format: 'pcm' } });
  const image = stubCompleteRequest({ image: { type: 'image', includeText: false } });
  const imageWithText = stubCompleteRequest({ image: { type: 'image', includeText: true } });
  const plain = stubCompleteRequest({ speech: undefined });
  const empty = newStreamFold();
  const text = newStreamFold();
  text.text = 'hi';
  const media = newStreamFold();
  media.text = 'hi';
  media.sawMedia = true;
  const reason = (req: typeof plain, fold: typeof empty) => {
    const ev = missingMediaError(req, fold);
    return ev?.type === 'error' ? ev.errorInternal : ev;
  };

  assertEquals(isVoiceProfile(voice), true);
  assertEquals(reason(voice, text), 'speech audio was not returned by the model');
  assertEquals(reason(voice, empty), 'speech audio was not returned by the model');
  assertEquals(reason(voice, media), undefined);
  assertEquals(reason(image, text), 'no image returned from image generation');
  assertEquals(reason(image, empty), 'no image returned from image generation');
  assertEquals(reason(imageWithText, text), 'no image returned from image generation');
  assertEquals(reason(image, media), undefined);
  assertEquals(reason(plain, text), undefined);
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
