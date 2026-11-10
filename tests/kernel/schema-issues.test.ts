import { assertEquals } from '@std/assert';
import { z } from 'zod';
import { issuePath, schemaIssueDetails } from '../../src/kernel/tools/schema-issues.ts';

const save = z.strictObject({ key: z.string(), from: z.array(z.string()).optional() });
const input = z.strictObject({ action: z.strictObject({ save }), note: z.string() });

Deno.test('a refused value keeps where each issue sits below its top-level field', () => {
  const parsed = input.safeParse({
    action: { save: { key: 'availability', availability: 'weekends', from: 'x' } },
    note: 1,
  });
  if (parsed.success) throw new Error('the input was accepted');
  assertEquals(schemaIssueDetails(parsed.error.issues), {
    formErrors: [],
    fieldErrors: {
      action: [
        'save.from: Invalid input: expected array, received string',
        'save: Unrecognized key: "availability"',
      ],
      note: ['Invalid input: expected string, received number'],
    },
  });
});

Deno.test('an issue on the value itself is a form error', () => {
  const parsed = input.safeParse('not an object');
  if (parsed.success) throw new Error('the input was accepted');
  assertEquals(schemaIssueDetails(parsed.error.issues).formErrors, [
    'Invalid input: expected object, received string',
  ]);
});

Deno.test('a path reads as dotted text, list places as numbers, the root as empty', () => {
  assertEquals(issuePath(['plants', 0, 'name']), 'plants.0.name');
  assertEquals(issuePath([]), '');
});
