import { assertEquals } from '@std/assert';
import { pageAddress, pairAt, pairs, placeFor, RUNNING_PATH, serverAddress } from '../ports.mjs';
import { STUDIO_BASE } from '../server/handler.ts';
import { FIRST_PROJECT_ENDPOINT } from '../ui/lib/project-address.ts';

const held = (...taken: (string | boolean)[]) =>
  taken.map((what, at) => ({
    pair: pairAt(at),
    ...(typeof what === 'string' ? { setup: what } : {}),
    free: what === true,
  }));

Deno.test('a page is one port above its server, and pairs do not overlap', () => {
  assertEquals(pairAt(0), { server: 4983, page: 4984 });
  assertEquals(pairAt(1), { server: 4985, page: 4986 });
  assertEquals(
    new Set(pairs().flatMap((pair) => [pair.server, pair.page])).size,
    pairs().length * 2,
  );
});

Deno.test('a page that is told nothing looks where the first studio listens', () => {
  assertEquals(FIRST_PROJECT_ENDPOINT, serverAddress(pairAt(0)) + STUDIO_BASE);
  assertEquals(RUNNING_PATH, `${STUDIO_BASE}/running`);
  assertEquals(pageAddress(pairAt(0)), 'http://127.0.0.1:4984');
});

Deno.test('a setup opens on the first free pair', () => {
  assertEquals(placeFor('/a/studio.setup.ts', held(true, true)), {
    pair: pairAt(0),
    running: false,
  });
});

Deno.test('a second project opens beside the first', () => {
  assertEquals(placeFor('/b/studio.setup.ts', held('/a/studio.setup.ts', true)), {
    pair: pairAt(1),
    running: false,
  });
});

Deno.test('a setup already open is found where it is, even past a free pair', () => {
  assertEquals(placeFor('/b/studio.setup.ts', held(true, '/b/studio.setup.ts')), {
    pair: pairAt(1),
    running: true,
  });
});

Deno.test('a pair something else holds is passed over, and no free pair is no place', () => {
  assertEquals(placeFor('/a/studio.setup.ts', held(false, true))?.pair, pairAt(1));
  assertEquals(placeFor('/a/studio.setup.ts', held(false, '/b/studio.setup.ts')), undefined);
});
