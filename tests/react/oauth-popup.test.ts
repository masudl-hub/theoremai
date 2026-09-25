import { assertEquals } from '@std/assert';
import { isOAuthComplete } from '../../react/src/client/oauth-popup.ts';

const ORIGIN = 'https://app.example';
const popup = {} as Window;
const other = {} as Window;

function message(data: unknown, source: Window, origin = ORIGIN): MessageEvent {
  return { data, source, origin } as MessageEvent;
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
