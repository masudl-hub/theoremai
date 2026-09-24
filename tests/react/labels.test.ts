import { assertEquals, assertThrows } from '@std/assert';
import { IntlMessageFormat } from 'intl-messageformat';
import {
  assertLabelOverrides,
  THEOREM_UI_CATALOG,
  type TheoremLabels,
} from '../../react/src/ui/labels.ts';
import { defaultLabels as t } from './default-labels.ts';

/** Labels as a builder might pass them, typos included, past the compile-time key check. */
function unchecked(labels: Record<string, Record<string, unknown>>): TheoremLabels {
  return labels as TheoremLabels;
}

Deno.test('every default line is valid ICU and uses only its declared values', () => {
  for (const [key, entry] of Object.entries(THEOREM_UI_CATALOG)) {
    const params: readonly string[] = 'params' in entry ? entry.params : [];
    const text = new IntlMessageFormat(entry.defaultMessage, 'en').format(
      Object.fromEntries(params.map((name) => [name, 'x'])),
    );
    assertEquals(typeof text, 'string', key);
    assertEquals(entry.description.length > 0, true, key);
  }
});

Deno.test('default lines format their values', () => {
  assertEquals(t('@theorem.agent.handle', { handle: 'nova' }), '@nova');
  assertEquals(t('@theorem.composer.placeholder', { handle: 'nova' }), 'Message @nova');
  assertEquals(
    t('@theorem.gate.auth.secret_placeholder', { slot: 'github' }),
    "Secret for slot 'github'",
  );
  assertEquals(
    t('@theorem.gate.auth.provided', { slot: 'github' }),
    'Credential provided for github',
  );
  assertEquals(t('@theorem.duration.seconds', { seconds: 3.2 }), '3.2s');
  assertEquals(t('@theorem.voice_note.remove', { name: 'voice.webm' }), 'Remove voice.webm');
  assertEquals(t('@theorem.gate.tag.always_confirm'), 'always_confirm');
});

Deno.test('assertLabelOverrides accepts valid Theorem and Astryx lines', () => {
  assertLabelOverrides(
    {
      en: { '@theorem.chat.greeting': 'What shall we do?', '@astryx.chatSendButton.send': 'Go' },
      'en-GB': { '@theorem.composer.placeholder': 'Write to @{handle}' },
      de: {
        '@theorem.composer.drawer.queue.count': '{n, plural, one {# wartet} other {# warten}}',
      },
    },
    true,
  );
});

Deno.test('assertLabelOverrides names the locale, key and problem', () => {
  const cases: [Record<string, Record<string, unknown>>, string][] = [
    [
      { en: { '@theorem.chat.greting': 'Hi' } },
      'Theorem labels: en @theorem.chat.greting: no such label',
    ],
    [
      { en: { '@theorem.chat.greeting': 'Hi {' } },
      'Theorem labels: en @theorem.chat.greeting: not a valid ICU message',
    ],
    [
      { en: { '@theorem.composer.placeholder': 'Message {name}' } },
      'Theorem labels: en @theorem.composer.placeholder: the message may only use {handle}',
    ],
    [
      { en: { '@theorem.chat.greeting': 'Hi {name}' } },
      'Theorem labels: en @theorem.chat.greeting: the message takes no values',
    ],
    [
      { en: { '@theorem.chat.greeting': 42 } },
      'Theorem labels: en @theorem.chat.greeting: the message must be a string',
    ],
    [
      { en: { greeting: 'Hi' } },
      'Theorem labels: en greeting: keys start with @theorem. or @astryx.',
    ],
    [
      { en: { '@astryx.chatSendButton.send': 'Go {' } },
      'Theorem labels: en @astryx.chatSendButton.send: not a valid ICU message',
    ],
    [{ 'not a locale': {} }, 'Theorem labels: not a locale: not a BCP 47 locale'],
    [JSON.parse('{"__proto__": {}}'), 'Theorem labels: __proto__: not a BCP 47 locale'],
  ];
  for (const [labels, message] of cases) {
    assertThrows(() => assertLabelOverrides(unchecked(labels), true), Error, message);
  }
});

Deno.test("assertLabelOverrides leaves a host's own keys alone unless strict", () => {
  assertLabelOverrides(unchecked({ en: { 'app.title': 'My app', '@astryx.x': '{' } }), false);
  assertThrows(
    () =>
      assertLabelOverrides(
        unchecked({ en: { 'app.title': 'x', '@theorem.chat.nope': 'x' } }),
        false,
      ),
    Error,
    'Theorem labels: en @theorem.chat.nope: no such label',
  );
});
