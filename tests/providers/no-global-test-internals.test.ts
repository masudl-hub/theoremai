// F-01: the global test bag must never appear after loading the public and provider surface.
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import '../../mod.ts';
import '../../src/providers/create-provider.ts';
import '../../src/providers/probe.ts';

/** Assembled so this file does not contain the banned whole-token literal. */
const BANNED_GLOBALS = [['__theorem', 'TestInternals'].join('')];

Deno.test('loading public surface does not install a global test-internals bag', () => {
  const g = globalThis as Record<string, unknown>;
  for (const banned of BANNED_GLOBALS) {
    assertEquals(Object.hasOwn(g, banned), false);
    assertEquals(g[banned], undefined);
  }
});
