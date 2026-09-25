import { assert, assertEquals } from '@std/assert';
import { PROFILE_FIELD_PRESENCE } from '../../src/kernel/profile-presence.ts';
import { fieldMeta } from '../../src/kernel/schema.ts';
import type { ModelBinding } from '../../src/kernel/types.ts';

/** The keys of `T` an object can't leave out. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

Deno.test('every presence path is a PROFILE_FIELDS key carrying its presence', () => {
  for (const [path, presence] of Object.entries(PROFILE_FIELD_PRESENCE)) {
    const meta = fieldMeta(path);
    assert(meta, `${path} is not in PROFILE_FIELDS`);
    assertEquals(meta.required, presence.required, path);
    assertEquals(meta.unset, presence.unset, path);
  }
});

Deno.test('every presence entry says something', () => {
  for (const [path, presence] of Object.entries(PROFILE_FIELD_PRESENCE)) {
    assert(presence.required !== undefined || presence.unset !== undefined, path);
    const alwaysRequired = presence.required === true;
    assert(!alwaysRequired || presence.unset === undefined, `${path} is always required`);
  }
});

Deno.test("a model binding's always-required fields are the ones its type requires", () => {
  const required = [
    'apiId',
    'protocol',
    'provider',
  ] as const satisfies readonly RequiredKeys<ModelBinding>[];
  // Fails to compile if ModelBinding gains a required key the list lacks.
  const exhaustive: (typeof required)[number] = '' as RequiredKeys<ModelBinding>;
  void exhaustive;
  const marked = Object.entries(PROFILE_FIELD_PRESENCE)
    .filter(([path, presence]) => /^models\.\*\.[^.]+$/.test(path) && presence.required === true)
    .map(([path]) => path.slice('models.*.'.length))
    .sort();
  assertEquals(marked, [...required]);
});
