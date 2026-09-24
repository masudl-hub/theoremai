import '../fixtures/test-host.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  ALL_PROFILE_TYPES,
  PROFILE_FIELD_SCOPE,
  profileFieldScope,
  profileTypesForField,
} from '../../src/kernel/profile-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { fieldMeta, PROFILE_FIELDS, PROFILE_TYPES } from '../../src/kernel/schema.ts';

/** The scope of `path`'s nearest scoped ancestor, excluding `path` itself. */
function ancestorScope(path: string) {
  const parent = path.split('.').slice(0, -1).join('.');
  return parent ? profileFieldScope(parent) : undefined;
}

/** `{ a: { b: value } }` for `a.b`; `*` becomes a binding key. */
function setAt(path: string, value: unknown): Record<string, unknown> {
  let out: unknown = value;
  for (const key of path.split('.').reverse()) {
    out = { [key === '*' ? 'probe' : key]: out };
  }
  return out as Record<string, unknown>;
}

Deno.test('ALL_PROFILE_TYPES mirrors PROFILE_TYPES', () => {
  assertEquals([...ALL_PROFILE_TYPES], [...PROFILE_TYPES]);
});

Deno.test('every scoped path is a PROFILE_FIELDS key carrying its scope', () => {
  for (const [path, scope] of Object.entries(PROFILE_FIELD_SCOPE)) {
    assert(path in PROFILE_FIELDS, `${path} is not in PROFILE_FIELDS`);
    assertEquals(fieldMeta(path)?.profileTypes, scope.profileTypes);
    assertEquals(fieldMeta(path)?.profileTypesReason, scope.reason);
  }
});

Deno.test('unscoped fields inherit their nearest scoped ancestor', () => {
  assertEquals(profileTypesForField('decision.contract'), ['decision']);
  assertEquals(fieldMeta('decision.contract')?.profileTypes, ['decision']);
  assertEquals(profileTypesForField('observability'), ALL_PROFILE_TYPES);
});

Deno.test("a scoped field's types are a subset of its ancestor's", () => {
  for (const path of Object.keys(PROFILE_FIELD_SCOPE)) {
    const parent = ancestorScope(path);
    if (!parent) continue;
    for (const type of PROFILE_FIELD_SCOPE[path].profileTypes) {
      assert(parent.profileTypes.includes(type), `${path} allows ${type}; its ancestor doesn't`);
    }
  }
});

Deno.test('defineProfile rejects each scoped field on a type outside its scope', () => {
  for (const [path, scope] of Object.entries(PROFILE_FIELD_SCOPE)) {
    const parent = ancestorScope(path);
    for (const type of ALL_PROFILE_TYPES) {
      if (scope.profileTypes.includes(type)) continue;
      // The ancestor's own rejection covers types it excludes.
      if (parent && !parent.profileTypes.includes(type)) continue;
      const concrete = path.replace('*', 'probe');
      assertThrows(
        () => defineProfile({ id: 'scope_probe', type, ...setAt(path, true) } as never),
        TheoremError,
        `type '${type}' must not set ${concrete}`,
      );
    }
  }
});

Deno.test("a scope's off value passes on types outside it", () => {
  const canary = PROFILE_FIELD_SCOPE['guardrails.canary'];
  assertEquals(canary.offValue, false);
  assertThrows(
    () =>
      defineProfile({
        id: 'scope_probe',
        type: 'host',
        guardrails: { canary: false },
      } as never),
    TheoremError,
    'tools.allow',
  );
});
