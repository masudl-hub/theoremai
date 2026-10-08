import '../fixtures/test-host.ts';
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import {
  compileStudio,
  createBlankDraft,
  createExampleDraft,
  newOwnDetector,
  type PatternDraft,
  type StudioDraft,
  studioSource,
} from '../../studio/mod.ts';
import { studioScope } from '../../studio/runtime-scope.ts';

type Guardrails = StudioDraft['guardrails'];

const ORDER: PatternDraft = {
  name: 'order',
  kind: 'pattern',
  pattern: 'ORD-\\d{6}',
  flags: 'i',
  words: [],
};
const CODENAMES: PatternDraft = {
  name: 'codename',
  kind: 'words',
  pattern: '',
  flags: '',
  words: ['Bluebird', ' night heron '],
};

function compiled(change: (guardrails: Guardrails) => Partial<Guardrails>) {
  const { guardrails } = createBlankDraft();
  return compileStudio({
    ...createExampleDraft(),
    guardrails: { ...guardrails, ...change(guardrails) },
  });
}

function detectOf(change: (guardrails: Guardrails) => Partial<Guardrails>) {
  const result = compiled(change);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const detect = result.profile.guardrails?.detect;
  if (typeof detect === 'string') throw new Error('expected a rule for each detector');
  return detect as Record<string, unknown> | undefined;
}

function issuesOf(change: (guardrails: Guardrails) => Partial<Guardrails>) {
  const result = compiled(change);
  if (result.ok) throw new Error('expected issues');
  return result.issues.map(({ field, index, message }) => ({ field, index, message }));
}

const ids = (source: Guardrails['sources'][string]) => (guardrails: Guardrails) => ({
  sources: { ...guardrails.sources, ids: source },
});

Deno.test("a detector reads with Theorem's patterns, the builder's, both or neither", () => {
  const mine = [{ name: 'order', pattern: 'ORD-\\d{6}', flags: 'i' }];
  assertEquals(detectOf(ids({ theorem: true, hint: '', patterns: [] })), undefined);
  assertEquals(detectOf(ids({ theorem: true, hint: '', patterns: [ORDER] })), {
    ids: { patterns: mine },
  });
  assertEquals(detectOf(ids({ theorem: false, hint: '', patterns: [ORDER] })), {
    ids: { theorem: false, patterns: mine },
  });
  assertEquals(detectOf(ids({ theorem: false, hint: '', patterns: [] })), {
    ids: { theorem: false },
  });
});

Deno.test('words compile trimmed, without flags', () => {
  assertEquals(detectOf(ids({ theorem: true, hint: '', patterns: [CODENAMES] })), {
    ids: { patterns: [{ name: 'codename', words: ['Bluebird', 'night heron'] }] },
  });
});

Deno.test('a pattern that cannot run is reported on its list', () => {
  const [issue] = issuesOf(
    ids({ theorem: true, hint: '', patterns: [{ ...ORDER, pattern: '(' }] }),
  );
  assertEquals(issue.field, 'sources.ids.patterns');
  assert(issue.message.includes('does not compile'), issue.message);

  const [twice] = issuesOf(ids({ theorem: true, hint: '', patterns: [ORDER, ORDER] }));
  assert(twice.message.includes('listed twice'), twice.message);
});

Deno.test("a builder's own detector compiles with its label, boundaries and patterns", () => {
  const own = {
    ...newOwnDetector(),
    key: 'acme.codenames',
    label: 'Codenames',
    patterns: [CODENAMES],
  };
  own.at.reply = 'block';
  assertEquals(
    detectOf(() => ({ own: [own] })),
    {
      'acme.codenames': {
        label: 'Codenames',
        at: { reply: 'block' },
        patterns: [{ name: 'codename', words: ['Bluebird', 'night heron'] }],
      },
    },
  );

  const issues = issuesOf(() => ({ own: [own, own] }));
  assertEquals(
    issues.map(({ field, index }) => ({ field, index })),
    [{ field: 'own', index: 1 }],
  );

  const [unnamed] = issuesOf(() => ({
    own: [{ ...own, patterns: [{ ...CODENAMES, words: [] }] }],
  }));
  assertEquals(unnamed.field, 'own.0.patterns');
});

Deno.test('a hint goes beside the patterns it speaks for', () => {
  const mine = [{ name: 'order', pattern: 'ORD-\\d{6}', flags: 'i' }];
  const hint = 'Leave out order numbers.';
  assertEquals(detectOf(ids({ theorem: true, hint: ` ${hint} `, patterns: [ORDER] })), {
    ids: { patterns: mine, hint },
  });
  assertEquals(detectOf(ids({ theorem: true, hint, patterns: [] })), undefined);
  const [long] = issuesOf(ids({ theorem: true, hint: 'x'.repeat(301), patterns: [ORDER] }));
  assertEquals(long.field, 'sources.ids.hint');

  const own = { ...newOwnDetector(), key: 'acme.codenames', label: 'Codenames', hint };
  own.patterns = [CODENAMES];
  own.at.reply = 'block';
  const detect = detectOf(() => ({ own: [own] }));
  assertEquals((detect?.['acme.codenames'] as { hint?: string } | undefined)?.hint, hint);
});

Deno.test('tool_leak lets the names a builder lists through', () => {
  assertEquals(
    detectOf(() => ({ innocentNames: [' search ', 'city'] })),
    {
      tool_leak: { allow: { names: ['search', 'city'] } },
    },
  );
  const [blank] = issuesOf(() => ({ innocentNames: ['search', ' '] }));
  assertEquals({ field: blank.field, index: blank.index }, { field: 'innocentNames', index: 1 });
});

Deno.test('exported code compiles the patterns as the host starts', () => {
  const plain = compiled(ids({ theorem: false, hint: '', patterns: [] }));
  assert(plain.ok);
  assert(!studioSource(plain).includes('compileDetect'));

  const result = compiled(ids({ theorem: true, hint: '', patterns: [ORDER] }));
  assert(result.ok);
  const source = studioSource(result);
  assertStringIncludes(
    source,
    "import { compileDetect } from '@theoremjs/agents/guardrails/compile';",
  );
  assertStringIncludes(source, 'detect: compileDetect({\n      ids: {');
  assertStringIncludes(source, "pattern: 'ORD-\\\\d{6}',");
});

Deno.test('a run compiles the patterns where it runs, and refuses one that could hang', async () => {
  const result = compiled(ids({ theorem: false, hint: '', patterns: [ORDER] }));
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  const { profile } = await studioScope(result.profile, result.customTools, result.structured, {
    mode: 'demo',
  });
  const detect =
    profile.guardrails && 'detect' in profile.guardrails
      ? (profile.guardrails.detect as Record<string, { compiled?: { patterns: unknown } }>)
      : {};
  assertEquals(detect.ids?.compiled?.patterns, [
    { name: 'order', source: 'ORD-\\d{6}', flags: 'i' },
  ]);

  const slow = compiled(
    ids({ theorem: true, hint: '', patterns: [{ ...ORDER, name: 'slow', pattern: '(a+)+b' }] }),
  );
  assert(slow.ok, JSON.stringify(!slow.ok && slow.issues));
  await assertRejects(
    () => studioScope(slow.profile, slow.customTools, slow.structured, { mode: 'demo' }),
    TheoremError,
    'slow',
  );
});
