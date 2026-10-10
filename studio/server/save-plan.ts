/**
 * What Save writes: each changed value of a profile or a tool, found in the
 * builder's file and rewritten there. A value written in the call is changed in
 * place. A value from a constant is changed where the constant is set, when
 * every profile and tool that reads the constant makes the same change, and the
 * plan says when other code reads the constant too. A value from a constant that
 * someone leaves as it was, or from code, is not written; the plan says where it
 * is set and who shares it. A tool's schema is changed in the Zod that writes it,
 * one part at a time (`zod-edit.ts`).
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
  isHeldId,
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
import {
  isWrittenOut,
  methodCall,
  methodSpan,
  readZod,
  type SchemaSide,
  unread,
  zodName,
  zodObject,
  zodSource,
} from './zod-edit.ts';

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

/** A tool's schemas, by the key its file writes each under. */
const TOOL_SCHEMAS: Record<string, { key: string; side: SchemaSide }> = {
  inputSchema: { key: 'input', side: 'input' },
  outputSchema: { key: 'output', side: 'output' },
};

/** The methods that say whether an object takes fields it does not name. */
const OPEN_METHODS = new Set(['strict', 'passthrough', 'loose']);

/** A new field's schema, written as Zod where a plain value would be. */
class ZodField {
  constructor(readonly write: (style: SourceStyle) => string) {}
}

/** A value as source: a new field as its Zod, anything else as it is. */
function written(value: unknown, style: SourceStyle): string {
  return value instanceof ZodField ? value.write(style) : valueSource(value, style);
}

/** An object's fields written out, one to a line, for an object that held none. */
function objectSource(entries: ReadonlyArray<[string, unknown]>, style: SourceStyle): string {
  const inner = { ...style, base: style.base + style.unit };
  const lines = entries.map(([key, value]) => `${inner.base}${keySource(key)}: ${written(value, inner)},`);
  return `{\n${lines.join('\n')}\n${style.base}}`;
}

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

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
  /** Code that is not a profile or a tool reads the value too. */
  readByCode?: boolean;
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
      // What is written in a value other code reads says so.
      ...(status === 'written' && this.frame.readByCode ? { readByCode: true } : {}),
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
   * knows whether each of them makes it (`settle`). A value other code reads is written as any
   * other, and each change to it says so. An id other code knows something by is not written.
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
    if (users.code && isHeldId(kind, path, origin)) {
      this.frame.changes.push(refused);
      return undefined;
    }
    if (!sharedWith.length && !users.code) return this.own;
    const frame = this.frames.get(holder.initializer) ?? {
      holder: holder.initializer,
      // Read by this one and by code: the change is this one's to make.
      everyone: sharedWith.length ? everyone : [subjectId(kind, of)],
      sharedWith,
      readByCode: users.code,
      edits: [],
      changes: [],
      refused: [],
    };
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
      const schema = this.subject.kind === 'tool' && path.length === 0 ? TOOL_SCHEMAS[key] : undefined;
      if (schema) {
        // A tool's schema is Zod in its file: each part that changed is changed there.
        const held = shape.entries.get(schema.key);
        if (!held) this.note('code', here, at);
        else if (!held.value || (open && !open.after.has(schema.key))) this.note('code', here, place(schema.key));
        else this.zod(held.value, before[key], after[key], here, schema.side);
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

  /** Runs `write` where `at` is written: in the subject's own call, or in the constant that holds it. */
  private within(at: Located, path: string[], write: () => void) {
    const frame = this.frameAt(at, at.node.getText(at.source), path);
    if (!frame) return;
    const outer = this.frame;
    this.frame = frame;
    write();
    this.frame = outer;
  }

  /**
   * A schema, in the Zod that writes it. A description, the values of an enum, whether a field
   * can be left out, and a field added or taken away are each changed where they are written,
   * through any constant that holds them. Any other change writes the schema again whole, when
   * it is written out where it stands in Zod the studio writes itself. What is left is for code.
   */
  private zod(
    at: Located,
    before: unknown,
    after: unknown,
    path: string[],
    side: SchemaSide,
    left: { was: boolean; now: boolean; path: string[] } = { was: false, now: false, path },
  ) {
    if (same(before, after) && left.was === left.now) return;
    const site: Located = { ...at, node: unwrapped(at.node) };
    const where: Place = { source: site.source, node: site.node };
    const read = readZod(this.project, site);
    if (!read || !isRecord(before) || !isRecord(after)) {
      this.note('code', path, where);
      return;
    }
    const stopped = unread(read);
    if (stopped) {
      this.note('code', path, { source: stopped.source, node: stopped.call });
      return;
    }
    const { base } = read;
    const inside = (node: ts.Expression): Located => ({ node, source: base.source, ...(base.env ? { env: base.env } : {}) });
    const [first] = base.call.arguments;
    const part = first && !ts.isSpreadElement(first) ? inside(first) : undefined;
    const list = part && base.name === 'union' ? unwrapped(part.node) : undefined;
    const members = list && ts.isArrayLiteralExpression(list) && !list.elements.some(ts.isSpreadElement) ? list.elements : undefined;
    const object = zodObject(this.project, read);
    const reads = new Set(['description']);
    if (object) reads.add('properties').add('required');
    // Whether an object takes fields it does not name is the `z.` call it starts from.
    const more = after.additionalProperties;
    const kind = !object
      ? undefined
      : more === true || (isRecord(more) && Object.keys(more).length === 0)
      ? 'looseObject'
      : more === false
      ? (side === 'input' ? 'strictObject' : 'object')
      : more === undefined && side === 'input'
      ? 'object'
      : undefined;
    if (kind) reads.add('additionalProperties');
    if (part && base.name === 'enum' && Array.isArray(before.enum) && Array.isArray(after.enum)) reads.add('enum');
    if (part && base.name === 'array' && isRecord(before.items) && isRecord(after.items)) reads.add('items');
    const [olds, news] = [before.anyOf, after.anyOf];
    if (
      members && Array.isArray(olds) && Array.isArray(news) && olds.length === news.length &&
      members.length === news.length
    ) reads.add('anyOf');
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !same(before[key], after[key]));
    if (changed.some((key) => !reads.has(key))) {
      this.rewritten(site, after, left.now, path, side);
      return;
    }

    // What is added to the schema goes after it, where it is used.
    let added = '';
    const notes: string[][] = [];
    const [was, now] = [before.description, after.description];
    if (!same(was, now)) {
      const here = [...path, 'description'];
      const describe = methodCall(read, 'describe');
      const [text] = describe?.call.arguments ?? [];
      if (now !== undefined && typeof now !== 'string') this.note('code', here, where);
      else if (was === undefined && now !== undefined) {
        added += `.describe(${valueSource(now, this.style(site.source, site.node.getStart(site.source)))})`;
        notes.push(here);
      } else if (!describe || !text || ts.isSpreadElement(text)) this.note('code', here, where);
      else {
        const call: Located = { node: describe.call, source: describe.source, ...(describe.env ? { env: describe.env } : {}) };
        this.within(call, here, () => {
          if (now !== undefined) {
            this.walk({ ...call, node: text }, was, now, here);
            return;
          }
          const { start, end } = methodSpan(describe);
          this.edit(describe.source, start, end, '');
          this.note('written', here, { source: describe.source, node: describe.call });
        });
      }
    }
    if (left.was && !left.now) {
      const optional = methodCall(read, 'optional');
      if (!optional) this.note('code', left.path, where);
      else {
        this.within({ node: optional.call, source: optional.source }, left.path, () => {
          const { start, end } = methodSpan(optional);
          this.edit(optional.source, start, end, '');
          this.note('written', left.path, { source: optional.source, node: optional.call });
        });
      }
    } else if (!left.was && left.now) {
      added += '.optional()';
      notes.push(left.path);
    }
    // One edit holds all that is added; each setting it adds is its own change.
    notes.forEach((here, index) => {
      this.within(site, here, () => {
        if (index === 0) this.edit(site.source, site.node.end, site.node.end, added);
        this.note('written', here, where);
      });
    });

    if (kind && !same(before.additionalProperties, more)) {
      const here = [...path, 'additionalProperties'];
      // A method that says it is taken away, and the call says it instead.
      for (const call of read.chain.filter((each) => OPEN_METHODS.has(each.name))) {
        this.within({ node: call.call, source: call.source }, here, () => {
          const { start, end } = methodSpan(call);
          this.edit(call.source, start, end, '');
        });
      }
      this.within(inside(base.call), here, () => {
        const name = (base.call.expression as ts.PropertyAccessExpression).name;
        if (name.text !== kind) this.edit(base.source, name.getStart(base.source), name.end, kind);
        this.note('written', here, { source: base.source, node: base.call });
      });
    }
    if (part && reads.has('enum') && !same(before.enum, after.enum)) {
      const here = [...path, 'enum'];
      this.within(inside(base.call), here, () => this.walk(part, before.enum, after.enum, here));
    }
    if (part && reads.has('items')) this.zod(part, before.items, after.items, [...path, 'items'], side);
    if (members && reads.has('anyOf') && Array.isArray(olds) && Array.isArray(news)) {
      members.forEach((member, index) => {
        this.zod(inside(member), olds[index], news[index], [...path, 'anyOf', String(index)], side);
      });
    }
    if (!object) return;

    const [fields, held] = [isRecord(before.properties) ? before.properties : {}, isRecord(after.properties) ? after.properties : {}];
    const [needed, needs] = [names(before.required), names(after.required)];
    const own: Located = { node: object.own.node, source: object.own.source };
    const inserts: Array<[string, unknown]> = [];
    const removed: ts.ObjectLiteralElementLike[] = [];
    for (const key of new Set([...Object.keys(fields), ...Object.keys(held)])) {
      const here = [...path, 'properties', key];
      const entry = object.entries.get(key);
      const optional = { was: !needed.includes(key), now: !needs.includes(key), path: [...path, 'required', key] };
      if (key in fields && key in held) {
        if (entry?.value) this.zod(entry.value, fields[key], held[key], here, side, optional);
        else if (!same(fields[key], held[key]) || optional.was !== optional.now) this.note('code', here, own);
      } else if (key in held) {
        const name = zodName(object.own.source);
        // The field is written as Zod once here, to know that it can be.
        if (!name || zodSource(held[key], optional.now, side, name) === undefined) this.note('code', here, own);
        else {
          const write = (style: SourceStyle) => zodSource(held[key], optional.now, side, name, style) ?? '';
          inserts.push([key, new ZodField(write)]);
        }
      } else {
        const property = entry?.property;
        if (!entry || !property || !ts.isObjectLiteralExpression(property.parent)) this.note('code', here, own);
        else if (property.parent === object.own.node) removed.push(property);
        else {
          this.within({ node: property.parent, source: entry.source }, here, () => {
            this.remove(property, entry.source);
            this.note('written', here, { source: entry.source, node: property });
          });
        }
      }
    }
    if (!inserts.length && !removed.length) return;
    const inFields = [...path, 'properties'];
    this.within(own, inFields, () => {
      const { node, source } = object.own;
      for (const property of removed) {
        this.note('written', [...inFields, propertyName(property) ?? ''], { source, node: property });
      }
      if (inserts.length && removed.length === node.properties.length) {
        // Every field goes and others come: the object is written whole.
        for (const [key] of inserts) this.note('written', [...inFields, key], own);
        const start = node.getStart(source);
        this.edit(source, start, node.end, objectSource(inserts, this.style(source, start)));
        return;
      }
      for (const property of removed) this.remove(property, source);
      if (inserts.length) this.insert(node, source, inserts, inFields);
    });
  }

  /** A schema written again whole, from its JSON Schema, where it stands. */
  private rewritten(site: Located, after: Json, optional: boolean, path: string[], side: SchemaSide) {
    const where: Place = { source: site.source, node: site.node };
    const name = zodName(site.source);
    const start = site.node.getStart(site.source);
    const text = name && isWrittenOut(this.project, site)
      ? zodSource(after, optional, side, name, this.style(site.source, start))
      : undefined;
    if (text === undefined) {
      this.note('code', path, where);
      return;
    }
    this.within(site, path, () => {
      this.edit(site.source, start, site.node.end, text);
      this.note('written', path, where);
    });
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
      this.edit(source, start, node.end, objectSource(entries, this.style(source, start)));
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
      const lines = entries.map(([key, value]) => `${base}${keySource(key)}: ${written(value, style)},\n`);
      if (!trailing) this.edit(source, last.end, last.end, ',');
      const at = source.getPositionOfLineAndCharacter(braceLine, 0);
      this.edit(source, at, at, lines.join(''));
      return;
    }
    const style = this.style(source, start);
    const fields = entries.map(([key, value]) => `${keySource(key)}: ${written(value, style)}`).join(', ');
    if (trailing) this.edit(source, node.properties.end, node.properties.end, ` ${fields},`);
    else this.edit(source, last.end, last.end, `, ${fields}`);
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
