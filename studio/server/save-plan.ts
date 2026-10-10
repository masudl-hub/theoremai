/**
 * What Save writes: each changed value of a profile or a tool, found in the
 * builder's file and rewritten there. A value written in the call is changed in
 * place. A value from a constant is changed where the constant is set, when
 * every profile and tool that reads the constant makes the same change. A value
 * from a constant that someone leaves as it was, or that other code reads, or
 * from code, is not written; the plan says where it is set and who shares it.
 *
 * @module
 */

import ts from 'typescript';
import { type SourceStyle, valueSource } from '../source.ts';
import { keySource } from '../tool-schema.ts';
import { canonical } from './canonical.ts';
import {
  followed,
  holderOf,
  isInCall,
  isInTarget,
  type Located,
  type ObjectShape,
  type ProjectSource,
  propertyName,
  shapeOf,
  type SourceTarget,
  unwrapped,
  usersOf,
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

export const NOT_PLAIN = Symbol('not plain');

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** The value an expression writes out in full, or `NOT_PLAIN` when it names or computes anything. */
export function plain(expression: ts.Expression): unknown {
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
export function indentAt(source: ts.SourceFile, position: number): string {
  const { line } = source.getLineAndCharacterOfPosition(position);
  const start = source.getPositionOfLineAndCharacter(line, 0);
  return /^[ \t]*/.exec(source.text.slice(start))?.[0] ?? '';
}

/** One level of a file's indentation: a tab, or its narrowest run of spaces. */
export function indentUnit(source: ts.SourceFile): string {
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

const subjectId = (kind: SaveSubject['kind'], of: string) => `${kind}:${of}`;

/** One profile's or tool's changes inside a value that others read too: a constant, what a function returns. */
interface SharedChange {
  /** The shared value, by where it is written. */
  holder: ts.Node;
  /** Who makes the changes, and everyone the value reaches. */
  by: string;
  everyone: string[];
  /** What the changes write and note when they are made. */
  edits: SourceEdit[];
  changes: SaveChange[];
  /** What the plan says instead when someone the value reaches does not make them. */
  refused: SaveChange[];
}

const editsText = (edits: readonly SourceEdit[]) =>
  canonical([...edits].sort((a, b) => a.start - b.start || a.end - b.end));

/**
 * Decides each shared value: its changes are written, once, when everyone it reaches makes the
 * same ones. Otherwise each change to it is refused, so no profile runs on a value it did not test.
 */
function settle(shared: readonly SharedChange[], plan: SavePlan) {
  for (const group of Map.groupBy(shared, (each) => each.holder).values()) {
    const [first] = group;
    if (!first) continue;
    const made = new Set(group.map((each) => each.by));
    const agreed = first.everyone.every((user) => made.has(user)) &&
      group.every((each) => editsText(each.edits) === editsText(first.edits));
    for (const each of group) plan.changes.push(...(agreed ? each.changes : each.refused));
    if (!agreed) continue;
    for (const edit of first.edits) {
      if (!plan.edits.some((other) => canonical(other) === canonical(edit))) plan.edits.push(edit);
    }
  }
}

/** Something a file writes, in that file. */
type Place = { source: ts.SourceFile; node: ts.Node };

/** One change as the planner notes it: its status, the setting's path, where it is set, and by what. */
type ChangeNote = [
  status: SaveStatus,
  path: string[],
  at?: Place,
  name?: string,
  shared?: Pick<SaveChange, 'sharedWith' | 'readByCode'>,
];

/** What the planner writes in one place: the subject's own call, or a value others read too. */
interface Frame {
  /** The shared value, by where it is written. Unset when the place is the subject's alone. */
  holder?: ts.Node;
  /** Everyone the value reaches, and the others among them by id or name. */
  everyone: string[];
  sharedWith: string[];
  edits: SourceEdit[];
  changes: SaveChange[];
  refused: SaveChange[];
}

class Planner {
  readonly shared: SharedChange[] = [];
  /** The subject's own call. Other profiles share it when a function makes the call for each. */
  private readonly root: Frame;
  /** What the subject alone writes: its own call, the arguments a function is called with for it. */
  private readonly own: Frame = { everyone: [], sharedWith: [], edits: [], changes: [], refused: [] };
  /** Each shared value the plan writes in, by where it is written. */
  private readonly frames = new Map<ts.Node, Frame>();
  private frame: Frame;

  constructor(
    private readonly project: ProjectSource,
    private readonly subject: SaveSubject,
    private readonly target: SourceTarget,
    peers: readonly string[],
  ) {
    const everyone = [subject.of, ...peers].map((name) => subjectId(subject.kind, name));
    this.root = peers.length
      ? { holder: target.options, everyone, sharedWith: [...peers], edits: [], changes: [], refused: [] }
      : this.own;
    this.frame = this.root;
  }

  /** What the subject alone writes. */
  get changes(): SaveChange[] {
    return this.own.changes;
  }

  get edits(): SourceEdit[] {
    return this.own.edits;
  }

  private note(...change: ChangeNote) {
    this.frame.changes.push(this.change(...change));
  }

  private change(...[status, path, at, name, shared = {}]: ChangeNote): SaveChange {
    return {
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
      ...shared,
    };
  }

  /** What holds `at`: the subject's own call, a constant or a function, or nothing the studio follows. */
  private regionOf(at: Located): ts.Node | undefined {
    if (isInTarget(this.target, at)) return this.target.options;
    return isInCall(this.target, at) ? this.target.call?.node : holderOf(at)?.initializer;
  }

  /**
   * Where a change to `origin` is written. In the subject's own call, or in a constant it alone
   * reads, the change is the subject's. In a value others read too it is kept apart until the plan
   * knows whether each of them makes it (`settle`). A value other code reads is not written.
   */
  private frameAt(origin: Located, name: string, path: string[]): Frame | undefined {
    if (isInTarget(this.target, origin)) return this.root;
    if (isInCall(this.target, origin)) return this.own;
    const holder = holderOf(origin);
    if (!holder) {
      this.note('constant', path, origin, name);
      return undefined;
    }
    const users = usersOf(this.project, holder);
    const everyone = [...users.profiles].map((id) => subjectId('profile', id))
      .concat([...users.tools].map((tool) => subjectId('tool', tool)));
    const { kind, of } = this.subject;
    const sharedWith = [...users.profiles].filter((id) => kind !== 'profile' || id !== of)
      .concat([...users.tools].filter((tool) => kind !== 'tool' || tool !== of));
    const refused = this.change('constant', path, origin, holder.name, {
      ...(sharedWith.length ? { sharedWith } : {}),
      ...(users.code ? { readByCode: true } : {}),
    });
    if (users.code) {
      this.frame.changes.push(refused);
      return undefined;
    }
    if (!sharedWith.length) return this.own;
    const frame = this.frames.get(holder.initializer) ??
      { holder: holder.initializer, everyone, sharedWith, edits: [], changes: [], refused: [] };
    this.frames.set(holder.initializer, frame);
    frame.refused.push(refused);
    return frame;
  }

  /** A value written somewhere other than where the walk is: changed there. */
  private enter(origin: Located, name: string, before: unknown, after: unknown, path: string[]) {
    const frame = this.frameAt(origin, name, path);
    if (!frame) return;
    const outer = this.frame;
    this.frame = frame;
    this.walk(origin, before, after, path);
    this.frame = outer;
  }

  /** A value a name, a key or a call stands for. One the studio cannot follow is not written. */
  private named(at: Located, name: string, before: unknown, after: unknown, path: string[]) {
    const origin = followed(this.project, at);
    const stayed = origin.node === unwrapped(at.node) && origin.source === at.source;
    const named = ts.isIdentifier(origin.node) || ts.isPropertyAccessExpression(origin.node);
    if (stayed) this.note(named ? 'constant' : 'code', path, origin, named ? name : undefined);
    else this.enter(origin, name, before, after, path);
  }

  private edit(source: ts.SourceFile, start: number, end: number, text: string) {
    const edit = { file: source.fileName, start, end, text };
    const held = this.frame.edits.some((other) => canonical(other) === canonical(edit));
    if (!held) this.frame.edits.push(edit);
  }

  private style(source: ts.SourceFile, position: number, existing?: ts.Expression): SourceStyle {
    return {
      unit: indentUnit(source),
      base: indentAt(source, position),
      template: true,
      quote: quoteLike(existing, source),
    };
  }

  /** The whole of the subject's call, and then what each shared value it wrote in holds. */
  plan() {
    const { options, source, env } = this.target;
    this.walk({ node: options, source, env }, this.subject.before, this.subject.after, []);
    const by = subjectId(this.subject.kind, this.subject.of);
    const { root } = this;
    if (root.holder && (root.changes.length || root.edits.length)) {
      // A function makes this call for others too: what Save would write here, it writes for each.
      const name = holderOf({ node: options, source })?.name;
      const refused = root.changes.map((change): SaveChange =>
        change.status === 'written'
          ? { ...change, status: 'constant', ...(name ? { name } : {}), sharedWith: root.sharedWith }
          : change
      );
      this.shared.push({ ...root, holder: root.holder, by, refused });
    }
    for (const frame of this.frames.values()) {
      if (frame.holder && (frame.changes.length || frame.edits.length)) this.shared.push({ ...frame, holder: frame.holder, by });
    }
  }

  private walk(at: Located, before: unknown, after: unknown, path: string[]) {
    if (same(before, after)) return;
    const node = unwrapped(at.node);
    const here: Located = { ...at, node };
    const { source } = at;
    const shape = isRecord(before) && isRecord(after) ? shapeOf(this.project, here) : undefined;
    if (shape && isRecord(before) && isRecord(after)) {
      this.object(shape, here, before, after, path);
      return;
    }
    if (
      ts.isArrayLiteralExpression(node) && Array.isArray(before) && Array.isArray(after) &&
      before.length === after.length && node.elements.length === after.length &&
      !node.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))
    ) {
      node.elements.forEach((element, index) => {
        this.walk({ ...at, node: element }, before[index], after[index], [...path, String(index)]);
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
    this.named(here, node.getText(source), before, after, path);
  }

  private object(shape: ObjectShape, at: Located, before: Json, after: Json, path: string[]) {
    const { open, own } = shape;
    const region = this.regionOf(at);
    const place = (key: string): Place => {
      const entry = shape.entries.get(key);
      return entry?.property ? { source: entry.source, node: entry.property } : at;
    };
    const inserts: Array<[string, unknown]> = [];
    const removed: ts.ObjectLiteralElementLike[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[key], after[key])) continue;
      const here = [...path, key];
      // A tool's schemas are its Zod objects in code: the studio shows them and does not write them.
      if (this.subject.kind === 'tool' && path.length === 0 && (key === 'inputSchema' || key === 'outputSchema')) {
        this.note('code', here, shape.entries.has(key.replace('Schema', '')) ? place(key.replace('Schema', '')) : at);
        continue;
      }
      const entry = shape.entries.get(key);
      if (!entry) {
        // Past a spread the studio could not follow, the object may hold the key already.
        if (open || !own) this.note('code', here, at);
        else if (after[key] === undefined) this.note('unfound', here, at);
        else inserts.push([key, after[key]]);
        continue;
      }
      const { property, value } = entry;
      if (open && !open.after.has(key)) this.note('code', here, place(key));
      else if (!value) this.note('code', here, place(key));
      else if (property && ts.isShorthandPropertyAssignment(property)) this.named(value, key, before[key], after[key], here);
      else if (after[key] === undefined) {
        // A key another object spreads in is not this one's to take out.
        if (!property || !own || property.parent !== own.node) this.note('code', here, place(key));
        else {
          removed.push(property);
          this.note('written', here, place(key));
        }
      } else if (this.regionOf(value) === region) this.walk(value, before[key], after[key], here);
      else this.enter(value, key, before[key], after[key], here);
    }
    if (!own) return;
    if (inserts.length && removed.length === own.node.properties.length) {
      // Every property goes and others come: the object is written whole, as an empty one is.
      for (const [key] of inserts) this.note('written', [...path, key], own);
      const start = own.node.getStart(own.source);
      this.edit(own.source, start, own.node.end, valueSource(Object.fromEntries(inserts), this.style(own.source, start)));
      return;
    }
    for (const held of removed) this.remove(held, own.source);
    if (inserts.length) this.insert(own.node, own.source, inserts, path);
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
  const shared: SharedChange[] = [];
  for (const subject of subjects) {
    if (same(subject.before, subject.after)) continue;
    const defined = subject.kind === 'profile' ? project.profiles : project.tools;
    const targets = defined.get(subject.of) ?? [];
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
    // The others a function makes this same call for.
    const peers = [...defined].filter(([name, held]) =>
      name !== subject.of && held.some((other) => other.options === target.options)
    ).map(([name]) => name);
    const planner = new Planner(project, subject, target, peers);
    planner.plan();
    plan.changes.push(...planner.changes);
    plan.edits.push(...planner.edits);
    shared.push(...planner.shared);
  }
  settle(shared, plan);
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
