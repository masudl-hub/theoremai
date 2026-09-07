/**
 * Pressure probes for F-04 / F-06 — not part of the permanent suite naming;
 * lives under tests so Deno resolves package imports.
 */
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import type { ProviderCompleteRequest } from '../../../../src/kernel/types.ts';
import {
  emitToolCallFromRawArguments,
  finalizeStructured,
  isVoiceProfile,
  missingSpeechAudioError,
  newStreamFold,
  parseArgumentsObject,
  shouldReportMissingSpeechAudio,
} from '../../../../src/providers/google/interactions/stream.ts';

Deno.test('F-06 pressure: parseArgumentsObject edge matrix', () => {
  assertEquals(parseArgumentsObject(''), { ok: true, value: {} });
  assertEquals(parseArgumentsObject('   '), { ok: true, value: {} });
  assertEquals(parseArgumentsObject(undefined), { ok: true, value: {} });
  assertEquals(parseArgumentsObject(null), { ok: true, value: {} });
  assertEquals(parseArgumentsObject('{"a":1}'), { ok: true, value: { a: 1 } });
  assertEquals(parseArgumentsObject({ a: 1 }), { ok: true, value: { a: 1 } });

  assertEquals(parseArgumentsObject('null').ok, false);
  assertEquals(parseArgumentsObject('[1]').ok, false);
  assertEquals(parseArgumentsObject('42').ok, false);
  assertEquals(parseArgumentsObject('true').ok, false);
  assertEquals(parseArgumentsObject('{"a":').ok, false);
  assertEquals(parseArgumentsObject('"{\\"a\\":1}"').ok, false);
  assertEquals(parseArgumentsObject([1]).ok, false);
  assertEquals(parseArgumentsObject(1).ok, false);
});

Deno.test('F-06 pressure: emitToolCallFromRawArguments never invents quiet {}', () => {
  const fold = newStreamFold();
  const events = emitToolCallFromRawArguments({ id: 'c1', name: 't' }, '{bad', fold);
  assertEquals(events.length, 1);
  assertEquals(events[0]?.tool?.phase, 'error');
  assertEquals(events[0]?.tool?.failure?.code, 'malformed_arguments');
  assertEquals(events[0]?.tool?.arguments, {});
});

Deno.test('F-04 pressure: missing-audio gate matrix', () => {
  const voice = { speech: { voice: 'Kore', format: 'pcm' as const } } as ProviderCompleteRequest;
  const plain = { speech: undefined } as ProviderCompleteRequest;
  const empty = newStreamFold();
  const text = newStreamFold();
  text.text = 'hi';
  const media = newStreamFold();
  media.text = 'hi';
  media.sawStreamedMedia = true;

  assertEquals(isVoiceProfile(voice), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, text), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, empty), true);
  assertEquals(shouldReportMissingSpeechAudio(voice, media), false);
  assertEquals(shouldReportMissingSpeechAudio(plain, text), false);

  const err = [...missingSpeechAudioError()];
  assertEquals(err[0]?.type, 'error');
  assertEquals(String(err[0]?.errorInternal).includes('speech audio'), true);
});

Deno.test('structured-required + bad JSON emits error (never silent skip)', () => {
  const fold = newStreamFold();
  fold.text = 'not json';
  const req = { structured: 'chatTurn' } as ProviderCompleteRequest;
  const events = [...finalizeStructured(req, fold)];
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals(events[0]?.errorInternal, 'structured output was not valid JSON');

  fold.text = '{"ok":true}';
  assertEquals(
    [...finalizeStructured(req, fold)],
    [{ type: 'structured', structured: { ok: true } }],
  );
});
