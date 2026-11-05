import { assertEquals } from '@std/assert';
import { HOST_LABEL_KEYS, LABEL_KEYS } from '../../src/guardrails/mod.ts';
import { labelAreaOf, PROFILE_LABEL_KEYS } from '../../studio/mod.ts';

Deno.test('every line a profile can change has an area on the Labels page', () => {
  assertEquals(
    PROFILE_LABEL_KEYS.filter((key) => !labelAreaOf(key)),
    [],
  );
});

Deno.test('no line only the host changes is on the Labels page', () => {
  assertEquals(
    HOST_LABEL_KEYS.filter((key) => labelAreaOf(key)),
    [],
  );
});

Deno.test('every labels key is a profile line or a host line', () => {
  assertEquals(PROFILE_LABEL_KEYS.length + HOST_LABEL_KEYS.length, LABEL_KEYS.length);
});
