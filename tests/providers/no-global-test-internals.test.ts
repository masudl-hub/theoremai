/**
 * Effect-level guard for F-01: the old global test bag must never appear after
 * loading the public / provider surface.
 *
 * Static lint catches natural spellings of the banned name. This test checks
 * the *effect*. The key is assembled here on purpose so the guard can name the
 * bag without embedding the banned literal (which lint correctly rejects).
 */
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import '../../mod.ts';
import '../../src/providers/create-provider.ts';
import '../../src/providers/probe.ts';

/** Assembled so this file does not contain the banned whole-token literal. */
const BANNED_GLOBAL = ['__theorum', 'TestInternals'].join('');

Deno.test('loading public surface does not install a global test-internals bag', () => {
  const g = globalThis as Record<string, unknown>;
  assertEquals(Object.hasOwn(g, BANNED_GLOBAL), false);
  assertEquals(g[BANNED_GLOBAL], undefined);
});
