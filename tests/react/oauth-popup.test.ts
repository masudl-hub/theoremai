import { assertEquals } from '@std/assert';
import { isOAuthComplete, notifyOAuthComplete } from '../../react/src/client/oauth-popup.ts';

const ORIGIN = 'https://app.example';
const popup = {};
const other = {};

function message(data: unknown, source: object, origin = ORIGIN) {
  return { data, source, origin };
}

/** Run `notifyOAuthComplete` as a popup page on `ORIGIN` and return what it posted. */
function postedBy(slot: string): { data: unknown; origin: string }[] {
  const posted: { data: unknown; origin: string }[] = [];
  const opener = { postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) };
  Object.defineProperty(globalThis, 'opener', { value: opener, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: { origin: ORIGIN }, configurable: true });
  try {
    notifyOAuthComplete(slot);
  } finally {
    Reflect.deleteProperty(globalThis, 'opener');
    Reflect.deleteProperty(globalThis, 'location');
  }
  return posted;
}

Deno.test('the chat takes an OAuth completion only from its popup, origin, and slot', () => {
  const expected = { popup, slot: 'tracker', origin: ORIGIN };
  const done = { type: 'theorem.oauth_complete', slot: 'tracker' };
  assertEquals(isOAuthComplete(message(done, popup), expected), true);
  assertEquals(isOAuthComplete(message(done, other), expected), false);
  assertEquals(isOAuthComplete(message(done, popup, 'https://evil.example'), expected), false);
  assertEquals(isOAuthComplete(message({ ...done, slot: 'other' }, popup), expected), false);
  assertEquals(isOAuthComplete(message({ slot: 'tracker' }, popup), expected), false);
  assertEquals(isOAuthComplete(message('theorem.oauth_complete', popup), expected), false);
});

Deno.test('the popup posts only to its own origin, in the shape the chat accepts', () => {
  const [sent] = postedBy('tracker');
  assertEquals(sent.origin, ORIGIN);
  assertEquals(
    isOAuthComplete(message(sent.data, popup), { popup, slot: 'tracker', origin: ORIGIN }),
    true,
  );
});
