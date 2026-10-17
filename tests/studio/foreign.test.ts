import { assertEquals } from '@std/assert';
import { isForeign } from '../../studio/server/handler.ts';

const gate = { listenHost: '127.0.0.1:4983', pageOrigins: ['http://127.0.0.1:4984'] };

const asked = (headers: Record<string, string>) =>
  isForeign(
    new Request('http://127.0.0.1:4983/api/studio', {
      headers: { host: '127.0.0.1:4983', ...headers },
    }),
    gate,
  );

Deno.test("the server answers the studio's page and its own command, and no other caller in a browser", () => {
  assertEquals(asked({ origin: 'http://127.0.0.1:4984', 'sec-fetch-site': 'same-site' }), false);
  // The command that starts the studio asks which project a server holds, and names no page.
  assertEquals(asked({}), false);
  assertEquals(asked({ origin: 'https://elsewhere.example' }), true);
  assertEquals(asked({ origin: 'http://127.0.0.1:4986' }), true);
  // An image or a script tag on another page, and an address typed into a browser, name no page.
  assertEquals(asked({ 'sec-fetch-site': 'cross-site' }), true);
  assertEquals(asked({ 'sec-fetch-site': 'same-site' }), true);
  assertEquals(asked({ 'sec-fetch-site': 'none' }), true);
  assertEquals(asked({ host: 'studio.elsewhere.example:4983' }), true);
});
