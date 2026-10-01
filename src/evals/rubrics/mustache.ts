/**
 * The Mustache that rubric prompts are written in: variables (`{{name}}`,
 * dotted `{{a.b}}`, the current item `{{.}}`), triple braces, sections over
 * lists and values (`{{#name}}...{{/name}}`), inverted sections
 * (`{{^name}}`), and comments. Tags alone on a line take the line with them,
 * as the Mustache spec has it. Nothing is HTML-escaped: the output is a
 * prompt, not a page, so double and triple braces render alike. Partials,
 * delimiter changes and lambdas are refused, so a prompt that needs them
 * fails where it is read, not in a judge.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'name'; name: string }
  | { kind: 'section'; name: string; inverted: boolean; children: Token[] };

const TAG = /\{\{(\{?)([^}]*)\}?\}\}/g;

function templateError(message: string): TheoremError {
  return new TheoremError('config', `rubric template: ${message}`); // lexicon-exempt: developer contract error
}

/** A tag whose line holds nothing else: the whole line goes, newline included. */
function standalone(
  template: string,
  start: number,
  end: number,
): { from: number; to: number } | undefined {
  const lineStart = template.lastIndexOf('\n', start - 1) + 1;
  const newline = template.indexOf('\n', end);
  const lineEnd = newline === -1 ? template.length : newline;
  if (template.slice(lineStart, start).trim() !== '') return undefined;
  if (template.slice(end, lineEnd).trim() !== '') return undefined;
  return { from: lineStart, to: newline === -1 ? lineEnd : newline + 1 };
}

function parse(template: string): Token[] {
  const root: Token[] = [];
  const stack: { name: string; children: Token[] }[] = [{ name: '', children: root }];
  let cursor = 0;
  for (const match of template.matchAll(TAG)) {
    const [whole, triple = '', body = ''] = match;
    const inner = body.trim();
    const sigil = /^[#^/!&]/.test(inner) ? inner.charAt(0) : '';
    const rawName = inner.slice(sigil.length).trim();
    const start = match.index;
    const end = start + whole.length;
    if (/^[>=]/.test(rawName)) throw templateError(`${whole} is not supported`);
    const children = stack.at(-1)?.children ?? root;
    const block = triple === '' && ['#', '^', '/', '!'].includes(sigil);
    const line = block ? standalone(template, start, end) : undefined;
    const textEnd = line && line.from >= cursor ? line.from : start;
    if (textEnd > cursor) children.push({ kind: 'text', text: template.slice(cursor, textEnd) });
    cursor = line ? Math.max(line.to, end) : end;
    if (sigil === '!') continue;
    if (sigil === '#' || sigil === '^') {
      const section: Token = {
        kind: 'section',
        name: rawName,
        inverted: sigil === '^',
        children: [],
      };
      children.push(section);
      stack.push({ name: rawName, children: section.children });
    } else if (sigil === '/') {
      const open = stack.pop();
      if (!open || open.name !== rawName || stack.length === 0) {
        throw templateError(
          `{{/${rawName}}} closes ${open?.name ? `{{#${open.name}}}` : 'nothing'}`,
        );
      }
    } else {
      children.push({ kind: 'name', name: rawName });
    }
  }
  if (stack.length > 1) throw templateError(`{{#${stack.at(-1)?.name}}} is never closed`);
  if (cursor < template.length) root.push({ kind: 'text', text: template.slice(cursor) });
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Look a name up through the contexts, innermost first; a dotted name walks from where its first part is found. */
function lookup(name: string, contexts: readonly unknown[]): unknown {
  if (name === '.') return contexts.at(-1);
  const [head = '', ...rest] = name.split('.');
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const context = contexts[i];
    if (isRecord(context) && head in context) {
      return rest.reduce<unknown>(
        (value, part) => (isRecord(value) ? value[part] : undefined),
        context[head],
      );
    }
  }
  return undefined;
}

function falsy(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function render(tokens: readonly Token[], contexts: readonly unknown[]): string {
  let out = '';
  for (const token of tokens) {
    if (token.kind === 'text') out += token.text;
    else if (token.kind === 'name') out += text(lookup(token.name, contexts));
    else {
      const value = lookup(token.name, contexts);
      if (token.inverted) {
        if (falsy(value)) out += render(token.children, contexts);
      } else if (Array.isArray(value)) {
        for (const item of value) out += render(token.children, [...contexts, item]);
      } else if (!falsy(value)) {
        out += render(token.children, [...contexts, value]);
      }
    }
  }
  return out;
}

/** Render a template over a view. */
function renderTemplate(template: string, view: Readonly<Record<string, unknown>>): string {
  return render(parse(template), [view]);
}

/**
 * The names a template reads from its view, as written: every variable and
 * section outside any section, dotted paths whole (`output.messages`).
 * Names inside a section are read from its items and are not listed.
 */
function templatePaths(template: string): string[] {
  const paths = new Set<string>();
  for (const token of parse(template)) {
    if (token.kind !== 'text' && token.name !== '.') paths.add(token.name);
  }
  return [...paths];
}

/** The names a template reads from its view: each path's first part, once (`output` for `output.messages`). */
function templateVariables(template: string): string[] {
  return [...new Set(templatePaths(template).map((path) => path.split('.')[0] ?? path))];
}

export { renderTemplate, templatePaths, templateVariables };
