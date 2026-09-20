import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';
import {
  collectValidationFailures,
  formatValidationFailures,
  isAbsent,
} from '../../src/kernel/engine/runner/schema-validation.ts';

const ROOT: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    code: { type: 'string' },
    diagram: {
      type: 'object',
      properties: {
        mermaid: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['mermaid'],
    },
  },
  required: ['message'],
};

Deno.test('schema-validation: required missing fails; optional omitted skips', async () => {
  let codeCalls = 0;
  const failures = await collectValidationFailures(
    ROOT,
    { message: 'hi' },
    {
      code: () => {
        codeCalls += 1;
        return { isValid: false, error: 'nope' };
      },
    },
  );
  assertEquals(failures, []);
  assertEquals(codeCalls, 0);
});

Deno.test('schema-validation: required field missing is reported', async () => {
  const failures = await collectValidationFailures(ROOT, {}, undefined);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.path, 'message');
  assertEquals(failures[0]?.error.includes("required field 'message' is missing"), true);
});

Deno.test('schema-validation: optional present runs nested required and field validator', async () => {
  let mermaidCalls = 0;
  const failures = await collectValidationFailures(
    ROOT,
    { message: 'hi', diagram: { mermaid: 'bad' } },
    {
      'diagram.mermaid': (v) => {
        mermaidCalls += 1;
        return v === 'ok' ? { isValid: true } : { isValid: false, error: 'bad mermaid' };
      },
    },
  );
  assertEquals(mermaidCalls, 1);
  assertEquals(
    failures.map((f) => f.error),
    ['bad mermaid'],
  );
});

Deno.test('schema-validation: nested required missing under present optional', async () => {
  const failures = await collectValidationFailures(ROOT, { message: 'hi', diagram: {} }, undefined);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.path, 'diagram.mermaid');
});

Deno.test('schema-validation: null optional is absent', async () => {
  let calls = 0;
  const failures = await collectValidationFailures(
    ROOT,
    { message: 'hi', diagram: null },
    {
      'diagram.mermaid': () => {
        calls += 1;
        return { isValid: false, error: 'x' };
      },
    },
  );
  assertEquals(failures, []);
  assertEquals(calls, 0);
});

Deno.test('schema-validation: non-object root throws', async () => {
  await assertRejects(
    () => collectValidationFailures({ type: 'string' }, 'x', undefined),
    TheoremError,
    'JSON Schema object root',
  );
});

Deno.test('schema-validation: formatValidationFailures joins errors', () => {
  assertEquals(
    formatValidationFailures([
      { path: 'a', error: 'one' },
      { path: 'b', error: 'two' },
    ]),
    'one; two',
  );
});

Deno.test('schema-validation: isAbsent', () => {
  assertEquals(isAbsent(undefined), true);
  assertEquals(isAbsent(null), true);
  assertEquals(isAbsent(''), false);
  assertEquals(isAbsent(0), false);
});
