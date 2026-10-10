/**
 * The Mustache rubric prompts are written in: what renders, what a line of
 * tags leaves behind, and what is refused.
 */

import {
  renderTemplate,
  templatePaths,
  templateVariables,
} from '../../src/evals/rubrics/mustache.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';

Deno.test('variables, dotted names and triple braces render as written, nothing escaped', () => {
  assertEquals(
    renderTemplate('{{a}} {{b.c}} {{{d}}} {{& d}} {{missing}}.', {
      a: '<x> & "y"',
      b: { c: 2 },
      d: '{"k":1}',
    }),
    '<x> & "y" 2 {"k":1} {"k":1} .',
  );
});

Deno.test('a section repeats over a list, shows for a value, and an inverted one shows for nothing', () => {
  const template = '{{#items}}[{{.}}]{{/items}}{{^items}}none{{/items}}|{{#on}}{{name}}{{/on}}';
  assertEquals(renderTemplate(template, { items: ['a', 'b'], on: { name: 'n' } }), '[a][b]|n');
  assertEquals(renderTemplate(template, { items: [], on: false }), 'none|');
  // An item's names are read from it first, then from the contexts around it.
  assertEquals(
    renderTemplate('{{#list}}{{role}}:{{top}} {{/list}}', { list: [{ role: 'r' }], top: 't' }),
    'r:t ',
  );
});

Deno.test('a tag alone on its line takes the line with it', () => {
  assertEquals(
    renderTemplate('<o>\n{{#m}}\n{{role}}: {{content}}\n{{/m}}\n{{! note }}\n</o>', {
      m: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
    }),
    '<o>\nuser: hi\nassistant: yo\n</o>',
  );
});

Deno.test('a template names the paths it reads outside sections, and the variables they start from', () => {
  const template =
    '{{input}} {{#output.messages}}{{role}}{{/output.messages}}{{^output.tools}}-{{/output.tools}}';
  assertEquals(templatePaths(template), ['input', 'output.messages', 'output.tools']);
  assertEquals(templateVariables(template), ['input', 'output']);
});

Deno.test('partials, delimiter changes and unbalanced sections are refused', () => {
  for (const [template, message] of [
    ['{{> part}}', 'is not supported'],
    ['{{=<% %>=}}', 'is not supported'],
    ['{{#a}}x', '{{#a}} is never closed'],
    ['{{#a}}x{{/b}}', '{{/b}} closes {{#a}}'],
    ['x{{/a}}', '{{/a}} closes nothing'],
  ] as const) {
    assertThrows(() => renderTemplate(template, {}), TheoremError, message);
  }
});
