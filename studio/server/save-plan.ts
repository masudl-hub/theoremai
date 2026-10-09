/**
 * What Save writes: each changed value of a profile or a tool, found in the
 * builder's file and rewritten there. A value written in the call is changed in
 * place. A value that comes from a constant or from code is not written; the
 * plan says where it is set.
 *
 * @module
 */

import ts from 'typescript';
import { type SourceStyle, valueSource } from '../source.ts';
import { keySource } from '../tool-schema.ts';
import {
  followed,
  type ProjectSource,
  propertyName,
  type SourceTarget,
  unwrapped,
} from './project-source.ts';
import type { DiffHunk, SaveChange, SaveStatus } from './save-wire.ts';

/** A profile or tool that changed: its values before and after, as the studio compiles them. */
export interface SaveSubject {
  kind: 'profile' | 'tool';
  of: string;
  before: unknown;
  after: unknown;
}

/** One replacement in a file's text. An insertion has `start === end`. */
export interface SourceEdit {
  file: string;
  start: number;
  end: number;
  text: string;
}

export interface SavePlan {
  changes: SaveChange[];
  edits: SourceEdit[];
}

const NOT_PLAIN = Symbol('not plain');

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value` with every object's keys in order and nothing undefined, as text: equal values give equal text. */
export function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (!isRecord(item)) return item;
    const keys = Object.keys(item).filter((key) => item[key] !== undefined).sort();
    return Object.fromEntries(keys.map((key) => [key, ordered(item[key])]));
  };
  return JSON.stringify(ordered(value)) ?? 'undefined';
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** The value an expression writes out in full, or `NOT_PLAIN` when it names or computes anything. */
function plain(expression: ts.Expression): unknown {
  const node = unwrapped(expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(plain);
    return items.includes(NOT_PLAIN) ? NOT_PLAIN : items;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: Array<[string, unknown]> = [];
    for (const property of node.properties) {
      const name = propertyName(property);
      if (name === undefined || !ts.isPropertyAssignment(property)) return NOT_PLAIN;
      const value = plain(property.initializer);
      if (value === NOT_PLAIN) return NOT_PLAIN;
      entries.push([name, value]);
    }
    return Object.fromEntries(entries);
  }
  // Lines joined: how the studio's own printer writes text of several lines.
  if (
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join' && node.arguments.length === 1
  ) {
    const lines = plain(node.expression.expression);
    const between = plain(node.arguments[0] as ts.Expression);
    if (Array.isArray(lines) && typeof between === 'string' && lines.every((line) => typeof line === 'string')) {
      return lines.join(between);
    }
  }
  return NOT_PLAIN;
}

/** The whitespace a line starts with. */
function indentAt(source: ts.SourceFile, position: number): string {
  const { line } = source.getLineAndCharacterOfPosition(position);
  const start = source.getPositionOfLineAndCharacter(line, 0);
  return /^[ \t]*/.exec(source.text.slice(start))?.[0] ?? '';
}

/** One level of a file's indentation: a tab, or its narrowest run of spaces. */
function indentUnit(source: ts.SourceFile): string {
  let narrowest = 0;
  for (const line of source.text.split('\n')) {
    if (line.startsWith('\t')) return '\t';
    const width = /^ +(?=\S)/.exec(line)?.[0].length ?? 0;
    if (width && (!narrowest || width < narrowest)) narrowest = width;
  }
  return ' '.repeat(narrowest || 2);
}

/** Text of one line, in the quotes the file already uses at this spot. */
function quoteLike(existing: ts.Expression | undefined, source: ts.SourceFile) {
  const double = existing && ts.isStringLiteral(existing) && existing.getText(source).startsWith('"');
  return (text: string): string => {
    const body = JSON.stringify(text);
    if (double) return body;
    return `'${body.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
  };
}

class Planner {
  readonly changes: SaveChange[] = [];
  readonly edits: SourceEdit[] = [];

  constructor(private readonly project: ProjectSource, private readonly subject: SaveSubject) {}

  private note(status: SaveStatus, path: string[], at?: { source: ts.SourceFile; node: ts.Node }, name?: string) {
    this.changes.push({
      kind: this.subject.kind,
      of: this.subject.of,
      setting: path.join('.'),
      status,
      ...(at
        ? {
          file: at.source.fileName,
          line: at.source.getLineAndCharacterOfPosition(at.node.getStart(at.source)).line + 1,
        }
        : {}),
      ...(name ? { name } : {}),
    });
  }

  private edit(source: ts.SourceFile, start: number, end: number, text: string) {
    const edit = { file: source.fileName, start, end, text };
    const held = this.edits.some((other) => canonical(other) === canonical(edit));
    if (!held) this.edits.push(edit);
  }

  private style(source: ts.SourceFile, position: number, existing?: ts.Expression): SourceStyle {
    return {
      unit: indentUnit(source),
      base: indentAt(source, position),
      template: true,
      quote: quoteLike(existing, source),
    };
  }

  /** The whole of one target. */
  target(target: SourceTarget) {
    this.walk(target.options, target.source, this.subject.before, this.subject.after, []);
  }

  private walk(expression: ts.Expression, source: ts.SourceFile, before: unknown, after: unknown, path: string[]) {
    if (same(before, after)) return;
    const node = unwrapped(expression);
    if (ts.isObjectLiteralExpression(node) && isRecord(before) && isRecord(after)) {
      this.object(node, source, before, after, path);
      return;
    }
    if (
      ts.isArrayLiteralExpression(node) && Array.isArray(before) && Array.isArray(after) &&
      before.length === after.length && node.elements.length === after.length &&
      !node.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))
    ) {
      node.elements.forEach((element, index) => {
        this.walk(element, source, before[index], after[index], [...path, String(index)]);
      });
      return;
    }
    const value = plain(node);
    if (value !== NOT_PLAIN) {
      if (!same(value, before)) {
        this.note('changed', path, { source, node });
        return;
      }
      const start = node.getStart(source);
      this.edit(source, start, node.end, valueSource(after, this.style(source, start, node)));
      this.note('written', path, { source, node });
      return;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const origin = followed(this.project, { node, source });
      this.note('constant', path, origin, node.getText(source));
      return;
    }
    this.note('code', path, { source, node });
  }

  private object(node: ts.ObjectLiteralExpression, source: ts.SourceFile, before: Json, after: Json, path: string[]) {
    const properties = [...node.properties];
    const spread = properties.some(ts.isSpreadAssignment);
    const inserts: Array<[string, unknown]> = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[key], after[key])) continue;
      const here = [...path, key];
      // A tool's schemas are its Zod objects in code: the studio shows them and does not write them.
      if (this.subject.kind === 'tool' && path.length === 0 && (key === 'inputSchema' || key === 'outputSchema')) {
        const written = properties.find((property) => propertyName(property) === key.replace('Schema', ''));
        this.note('code', here, { source, node: written ?? node });
        continue;
      }
      const index = properties.findLastIndex((property) => propertyName(property) === key);
      const held = properties[index];
      if (!held) {
        if (spread) this.note('code', here, { source, node });
        else if (after[key] === undefined) this.note('unfound', here, { source, node });
        else inserts.push([key, after[key]]);
        continue;
      }
      if (properties.slice(index + 1).some(ts.isSpreadAssignment)) {
        this.note('code', here, { source, node: held });
      } else if (ts.isShorthandPropertyAssignment(held)) {
        this.note('constant', here, followed(this.project, { node: held.name, source }), key);
      } else if (!ts.isPropertyAssignment(held)) {
        this.note('code', here, { source, node: held });
      } else if (after[key] === undefined) {
        this.remove(held, source);
        this.note('written', here, { source, node: held });
      } else {
        this.walk(held.initializer, source, before[key], after[key], here);
      }
    }
    if (inserts.length) this.insert(node, source, inserts, path);
  }

  /** Takes a property out, with its comma. */
  private remove(property: ts.ObjectLiteralElementLike, source: ts.SourceFile) {
    const { text } = source;
    let start = property.getFullStart();
    let end = property.end;
    const comma = /^[ \t]*,/.exec(text.slice(end));
    if (comma) end += comma[0].length;
    else if (text[start - 1] === ',') start -= 1;
    this.edit(source, start, end, '');
  }

  /** Adds properties after the last one the object has. */
  private insert(node: ts.ObjectLiteralExpression, source: ts.SourceFile, entries: Array<[string, unknown]>, path: string[]) {
    for (const [key] of entries) this.note('written', [...path, key], { source, node });
    const last = node.properties.at(-1);
    const start = node.getStart(source);
    if (!last) {
      const style = this.style(source, start);
      this.edit(source, start, node.end, valueSource(Object.fromEntries(entries), style));
      return;
    }
    const trailing = node.properties.hasTrailingComma;
    const brace = node.end - 1;
    const braceLine = source.getLineAndCharacterOfPosition(brace).line;
    const ownLine = source.getLineAndCharacterOfPosition(last.end).line < braceLine;
    if (ownLine) {
      // On lines of their own, before the closing brace, so a comment after the last one stays with it.
      const base = indentAt(source, last.getStart(source));
      const style = { ...this.style(source, start), base };
      const lines = entries.map(([key, value]) => `${base}${keySource(key)}: ${valueSource(value, style)},\n`);
      if (!trailing) this.edit(source, last.end, last.end, ',');
      const at = source.getPositionOfLineAndCharacter(braceLine, 0);
      this.edit(source, at, at, lines.join(''));
      return;
    }
    const style = this.style(source, start);
    const written = entries.map(([key, value]) => `${keySource(key)}: ${valueSource(value, style)}`).join(', ');
    if (trailing) this.edit(source, node.properties.end, node.properties.end, ` ${written},`);
    else this.edit(source, last.end, last.end, `, ${written}`);
  }
}

/** Finds each subject's call in the project and plans its changes. */
export function planSave(project: ProjectSource, subjects: readonly SaveSubject[]): SavePlan {
  const plan: SavePlan = { changes: [], edits: [] };
  for (const subject of subjects) {
    if (same(subject.before, subject.after)) continue;
    const targets = (subject.kind === 'profile' ? project.profiles : project.tools).get(subject.of) ?? [];
    const whole = { kind: subject.kind, of: subject.of, setting: '' };
    const [target] = targets;
    if (!target) {
      plan.changes.push({ ...whole, status: 'unfound' });
      continue;
    }
    if (targets.length > 1) {
      // Written twice: the studio cannot tell which one runs.
      const line = target.source.getLineAndCharacterOfPosition(target.options.getStart(target.source)).line + 1;
      plan.changes.push({ ...whole, status: 'code', file: target.file, line });
      continue;
    }
    const planner = new Planner(project, subject);
    planner.target(target);
    plan.changes.push(...planner.changes);
    plan.edits.push(...planner.edits);
  }
  return plan;
}

/** `text` with the edits made. Throws when two edits touch the same characters. */
export function applyEdits(text: string, edits: readonly SourceEdit[]): string {
  const ordered = edits.map((edit, index) => ({ edit, index }))
    .sort((a, b) => a.edit.start - b.edit.start || a.index - b.index);
  let out = '';
  let cursor = 0;
  for (const { edit } of ordered) {
    if (edit.start < cursor) throw new Error('Two changes touch the same text.');
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}

const CONTEXT_LINES = 2;

/** The changed lines of one file, from the edits made to it. */
export function diffHunks(text: string, edits: readonly SourceEdit[]): DiffHunk[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (position: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= position) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const groups: Array<{ first: number; last: number; edits: SourceEdit[] }> = [];
  for (const edit of ordered) {
    const first = lineOf(edit.start);
    const last = lineOf(edit.end);
    const open = groups.at(-1);
    if (open && first <= open.last) {
      open.last = Math.max(open.last, last);
      open.edits.push(edit);
    } else groups.push({ first, last, edits: [edit] });
  }
  return groups.flatMap((group) => {
    const from = starts[group.first] ?? 0;
    const to = (starts[group.last] ?? 0) + (lines[group.last]?.length ?? 0);
    const local = group.edits.map((edit) => ({ ...edit, start: edit.start - from, end: edit.end - from }));
    const was = lines.slice(group.first, group.last + 1);
    const now = applyEdits(text.slice(from, to), local).split('\n');
    let head = 0;
    while (head < was.length && head < now.length && was[head] === now[head]) head++;
    let tail = 0;
    while (
      tail < was.length - head && tail < now.length - head &&
      was[was.length - 1 - tail] === now[now.length - 1 - tail]
    ) tail++;
    const removed = was.slice(head, was.length - tail);
    const added = now.slice(head, now.length - tail);
    if (!removed.length && !added.length) return [];
    const at = group.first + head;
    const after = at + removed.length;
    return [{
      line: at + 1,
      lead: lines.slice(Math.max(0, at - CONTEXT_LINES), at),
      removed,
      added,
      trail: lines.slice(after, after + CONTEXT_LINES),
    }];
  });
}
