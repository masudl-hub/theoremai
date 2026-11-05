import { assertEquals } from '@std/assert';
import { fieldDocs } from '../../scripts/gen-field-docs.ts';
import { BOUNDARY_META } from '../../src/guardrails/boundaries.ts';
import { DETECT_ACTION_META, DETECTOR_META } from '../../src/guardrails/detectors.ts';
import { API_EXPORTS, REQUEST_FIELDS } from '../../src/kernel/api-catalog.ts';
import { EXPORT_DOCS, FIELD_DOCS, OPTION_DOCS } from '../../src/kernel/field-docs.ts';
import { EXTRA_FIELDS, PROFILE_FIELDS } from '../../src/kernel/schema.ts';

const FIELDS = { ...PROFILE_FIELDS, ...EXTRA_FIELDS, ...REQUEST_FIELDS };

Deno.test('field-docs.ts is what the generator writes from the JSDoc now', () => {
  const { docs, exports, options, problems } = fieldDocs();
  assertEquals(problems, []);
  assertEquals(FIELD_DOCS, docs, 'run: deno task field-docs');
  assertEquals(EXPORT_DOCS, exports, 'run: deno task field-docs');
  assertEquals(OPTION_DOCS, options, 'run: deno task field-docs');
});

Deno.test("every row's option docs are a list's JSDoc, or DETECT_ACTION_META's", () => {
  const lists: object[] = Object.values(OPTION_DOCS);
  const unsourced = Object.entries(FIELDS)
    .filter(([, meta]) => meta.optionDescriptions && !lists.includes(meta.optionDescriptions))
    .filter(([, meta]) =>
      Object.entries(meta.optionDescriptions ?? {}).some(
        ([action, doc]) =>
          DETECT_ACTION_META[action as keyof typeof DETECT_ACTION_META]?.doc !== doc,
      ),
    )
    .map(([path]) => path);
  assertEquals(unsourced, []);
});

Deno.test('every catalog row and export has a doc', () => {
  const blank = [
    ...Object.entries(FIELDS).filter(([, meta]) => !meta.doc.trim()),
    ...Object.entries(API_EXPORTS).filter(([, meta]) => !meta.doc.trim()),
  ].map(([path]) => path);
  assertEquals(blank, []);
});

Deno.test('a row a declaration does not document takes its doc from DETECTOR_META or BOUNDARY_META', () => {
  const unsourced = Object.entries(FIELDS)
    .filter(([path, meta]) => {
      if (path in FIELD_DOCS) return false;
      const match = /^guardrails\.detect\.([^.]+)(?:\.at\.([^.]+))?$/.exec(path);
      if (!match) return true;
      const [, detector, boundary] = match;
      const source: Record<string, { doc: string }> = boundary ? BOUNDARY_META : DETECTOR_META;
      const doc = source[boundary ?? detector]?.doc;
      return !doc || !meta.doc.startsWith(doc) || (boundary !== undefined && meta.doc !== doc);
    })
    .map(([path]) => path);
  assertEquals(unsourced, []);
});
