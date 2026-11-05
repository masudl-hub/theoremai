import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  LABEL_KEYS,
  LABEL_NOTES,
  type LabelKey,
  labelDefault,
  labelPlaceholders,
  labelText,
  validateLabelOverrides,
} from '../../src/guardrails/labels.ts';

Deno.test('each labels note names the placeholders its key takes', () => {
  for (const key of LABEL_KEYS) {
    const named = [...LABEL_NOTES[key].matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
    assertEquals(new Set(named), new Set(labelPlaceholders(key)), key);
  }
});

Deno.test('a label override may leave out a placeholder its key takes', () => {
  validateLabelOverrides({ 'tool.not_allowed': "'{tool}' can't be used here." }, 'Profile p');
});

Deno.test('a label override may use only the placeholders its key takes', () => {
  assertThrows(
    () => validateLabelOverrides({ 'tool.not_allowed': "'{tol}' is off." }, 'Profile p'),
    TheoremError,
    "Profile p: labels 'tool.not_allowed' has {tol}, which is never filled in; it may only use {tool}, {profile}",
  );
  assertThrows(
    () => validateLabelOverrides({ 'error.cancelled': 'Stopped {when}.' }, 'Profile p'),
    TheoremError,
    "labels 'error.cancelled' has {when}, which is never filled in; it may only use {tool}",
  );
  assertThrows(
    () => validateLabelOverrides({ 'voice.empty': 'Nothing from {user}.' }, 'Profile p'),
    TheoremError,
    "labels 'voice.empty' has {user}, which is never filled in; it takes no placeholders",
  );
});

Deno.test('a canary note override must keep {canary}', () => {
  assertThrows(
    () => validateLabelOverrides({ 'canary.bind_note': 'Keep it secret.' }, 'Profile p'),
    TheoremError,
    "labels 'canary.bind_note' must contain the {canary} placeholder",
  );
});

Deno.test('every placeholder a default fills is one an override may use', () => {
  for (const key of LABEL_KEYS) {
    const read = new Set<string>();
    const params = new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name === 'string') read.add(name);
          return 'x';
        },
      },
    );
    labelDefault(key, params);
    assertEquals(
      [key, [...read].filter((name) => !labelPlaceholders(key).includes(name))],
      [key, []],
    );
  }
});

Deno.test('a background tool call override may name the tool', () => {
  const labels = { 'tool.background_started': '{tool} is still running.' };
  validateLabelOverrides(labels, 'Profile p');
  assertEquals(
    labelText('tool.background_started', { tool: 'lookup' }, labels),
    'lookup is still running.',
  );
});

/** The keys of an object literal at its top level, from just after its `{`; spreads are left out. */
function literalKeys(source: string, from: number): string[] {
  let depth = 1;
  let top = '';
  for (let at = from; at < source.length && depth > 0; at++) {
    const char = source[at];
    if ('{(['.includes(char)) depth++;
    else if ('})]'.includes(char)) depth--;
    else if (depth === 1) top += char;
  }
  return [...top.matchAll(/(?:^|,)\s*(\.\.\.)?(\w+)\s*(?=:|,|$)/g)]
    .filter(([, spread]) => !spread)
    .map(([, , name]) => name);
}

Deno.test('every placeholder a call site fills is one an override may use', async () => {
  const listed = await new Deno.Command('git', {
    args: [
      'ls-files',
      'src/*.ts',
      'web/src/*.ts',
      'web/src/*.tsx',
      'react/src/*.ts',
      'react/src/*.tsx',
      'studio/*.ts',
      'studio/*.tsx',
    ],
    stdout: 'piped',
  }).output();
  const files = new TextDecoder().decode(listed.stdout).trim().split('\n');
  let sites = 0;
  for (const file of files.filter((path) => !path.includes('/built/'))) {
    const source = await Deno.readTextFile(file);
    for (const call of source.matchAll(/\blabel(?:Text|Default)\(\s*'([\w.]+)'\s*,\s*\{/g)) {
      const key = call[1] as LabelKey;
      const at = `${file}:${source.slice(0, call.index).split('\n').length}`;
      assertEquals([at, LABEL_KEYS.includes(key)], [at, true]);
      const unknown = literalKeys(source, (call.index ?? 0) + call[0].length).filter(
        (name) => !labelPlaceholders(key).includes(name),
      );
      assertEquals([at, key, unknown], [at, key, []]);
      sites++;
    }
  }
  assertEquals(sites > 100, true);
});
