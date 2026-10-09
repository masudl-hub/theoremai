import { assert, assertEquals } from '@std/assert';
import { readdirSync, readFileSync } from 'node:fs';
import { PROFILE_FIELDS } from '../../mod.ts';

/**
 * Profile fields the studio editor has no row for, each with why. A field under one of
 * these is left out with it. Anything else in the kernel's catalog needs a row.
 */
const COMPILED = 'Worked out from the patterns where the agent runs.';

const NOT_IN_STUDIO: Record<string, string> = {
  'tools.t1Policy': 'A function that picks T1 tools each turn, written in code.',
  'inputs.state': 'Set by the Decision profile type.',
  'outputs.validation.fields': 'Check functions, written in code.',
  'guardrails.disclosure': 'A check function on decision state, written in code.',
  'guardrails.detect.ids.compiled': COMPILED,
  'guardrails.detect.financial.compiled': COMPILED,
  'guardrails.detect.network.compiled': COMPILED,
  'guardrails.detect.credentials.compiled': COMPILED,
  'guardrails.detect.injection.compiled': COMPILED,
  'guardrails.detect.tool_instructions.compiled': COMPILED,
  'guardrails.detect.tool_leak.compiled': COMPILED,
  'guardrails.detect.*.compiled': COMPILED,
  'guardrails.detect.*.find': 'A function that reads the text, written in code.',
  'observability.onWriteError': 'An error handler, written in code.',
  'models.*.compaction.trigger': 'A function that decides when to compact, written in code.',
};

// The editor's rows live in the package's screen files.
const components = new URL('../ui/', import.meta.url);
const source = readdirSync(components)
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => readFileSync(new URL(name, components), 'utf8'))
  .join('\n');

const paths = Object.keys(PROFILE_FIELDS);
/** Paths a row names: its `path` prop, or the catalog entry a bare control reads. */
const named = new Set(
  [...source.matchAll(/(?:path=\{?|fieldMeta\()['"`]([\w.*]+)['"`]/g)].map((match) => match[1]),
);
/** Checklists, whose path covers each of its children. */
const checklists = new Set(
  [...source.matchAll(/<FlagList[^>]*?path="([\w.*]+)"/g)].map((match) => match[1]),
);
/**
 * Rows named by a template with a literal start, such as `lexicon.${key}`: each `${…}` stands for
 * one segment.
 */
const templates = [...source.matchAll(/`(\w[\w.*]*\$\{[^`]*)`/g)].map(
  (match) =>
    new RegExp(
      `^${match[1]
        .split(/\$\{[^}]*\}/)
        .map((part) => part.replace(/[.*]/g, '\\$&'))
        .join('[^.]+')}$`,
    ),
);

const under = (path: string, parent: string) => path.startsWith(`${parent}.`);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('.'));

function hasRow(path: string): boolean {
  if (named.has(path)) return true;
  if (path.includes('.') && checklists.has(parentOf(path))) return true;
  if (templates.some((template) => template.test(path))) return true;
  // A record's entries are edited with the record.
  if (path.endsWith('.*') && named.has(parentOf(path))) return true;
  // A group is covered by its fields.
  return paths.some((child) => under(child, path) && hasRow(child));
}

const leftOut = (path: string) =>
  Object.keys(NOT_IN_STUDIO).some((out) => path === out || under(path, out));

Deno.test('every profile field has an editor row or a reason it has none', () => {
  const missing = paths.filter((path) => !hasRow(path) && !leftOut(path));
  assertEquals(missing, [], `No editor row for: ${missing.join(', ')}`);
});

Deno.test('every field left out is still in the catalog and still has no row', () => {
  for (const out of Object.keys(NOT_IN_STUDIO)) {
    assert(out in PROFILE_FIELDS, `${out} is no longer a profile field`);
    assert(!hasRow(out), `${out} has a row now; take it off the list`);
  }
});
