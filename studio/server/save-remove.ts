/**
 * Takes a profile or a tool the studio removed out of the project's files: the statement that
 * registers it, and what only that statement used. A definition something else still reads stays.
 * Whatever the files do that the studio cannot follow is named, and nothing is planned for it.
 *
 * @module
 */

import ts from 'typescript';
import {
  calleeName,
  isRead,
  type ProjectSource,
  propertyName,
  questionsExport,
  sourceOf,
  unwrapped,
} from './project-source.ts';
import type { SavePlan, SourceEdit } from './save-plan.ts';
import type { SaveChange } from './save-wire.ts';

/** What the studio took away: the ids of profiles and the names of tools the project has. */
export interface Removed {
  profiles: readonly string[];
  tools: readonly string[];
}

export interface RemovalPlan extends SavePlan {
  /** The files left with nothing of their own, which Save takes away. */
  gone: string[];
}

/** The calls that register what a profile's module holds. */
const REGISTERS = new Set(['registerProfile', 'registerStructured']);

/** Something a file writes that can be taken out whole. */
type Part = ts.Statement | ts.ObjectLiteralElementLike | ts.ImportSpecifier;

/** A definition with a name: the statement that declares it, in its file. */
interface Named {
  name: string;
  source: ts.SourceFile;
  statement: ts.Statement;
}

/** `node` with the wrappers around it that do not change what it is. */
function wrapped(node: ts.Node): ts.Node {
  let at = node;
  while (
    ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) ||
    ts.isSatisfiesExpression(at.parent) || ts.isNonNullExpression(at.parent) ||
    ts.isAwaitExpression(at.parent)
  ) at = at.parent;
  return at;
}

/** The statement an expression is the whole of, when it stands in a file or a block. */
function statementOf(expression: ts.Node): ts.ExpressionStatement | undefined {
  const { parent } = wrapped(expression);
  if (!ts.isExpressionStatement(parent)) return undefined;
  return ts.isSourceFile(parent.parent) || ts.isBlock(parent.parent) ? parent : undefined;
}

/** A file's top-level declaration that `value` is the whole value of: one `const`, alone in its statement. */
function declared(value: ts.Node, source: ts.SourceFile): Named | undefined {
  const { parent } = wrapped(value);
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return undefined;
  const statement = parent.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.parent !== source) return undefined;
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return undefined;
  if (statement.declarationList.declarations.length !== 1) return undefined;
  return { name: parent.name.text, source, statement };
}

/** The top-level function a statement is the whole body of. */
function wholeBodyOf(statement: ts.Statement, source: ts.SourceFile): Named | undefined {
  const block = statement.parent;
  if (!ts.isBlock(block) || block.statements.length !== 1) return undefined;
  const held = block.parent;
  if (!ts.isFunctionDeclaration(held) || held.parent !== source || !held.name) return undefined;
  return { name: held.name.text, source, statement: held };
}

/** How one file knows a definition, and where it reads it. */
interface Reader {
  source: ts.SourceFile;
  reads: ts.Identifier[];
  /** What brings the name into the file, when an import does. */
  imported?: ts.ImportSpecifier | ts.ImportDeclaration;
  /** What else the file reads of the definition's module, when it imports the module whole. */
  others: ts.Identifier[];
  /** The file passes the name on to others, so what reads it there is out of sight. */
  passesOn: boolean;
}

function readsIn(source: ts.SourceFile, name: string, declaration?: ts.Node): ts.Identifier[] {
  const reads: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name && node.parent !== declaration && isRead(node)) reads.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** Each import and re-export of `home` the project's other files write. */
function* importsOf(
  project: ProjectSource,
  home: ts.SourceFile,
): Generator<{ source: ts.SourceFile; statement: ts.ImportDeclaration | ts.ExportDeclaration }> {
  for (const source of project.files.values()) {
    if (source === home) continue;
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
      if (sourceOf(project, source, specifier.text) === home) yield { source, statement };
    }
  }
}

/** How one import of a definition's file reads the definition, when it brings it in. */
function importReader(source: ts.SourceFile, statement: ts.ImportDeclaration, named: Named): Reader | undefined {
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return undefined;
  if (ts.isNamespaceImport(bindings)) {
    const all = readsIn(source, bindings.name.text);
    const own = (read: ts.Identifier) =>
      ts.isPropertyAccessExpression(read.parent) && read.parent.expression === read && read.parent.name.text === named.name;
    return { source, reads: all.filter(own), others: all.filter((read) => !own(read)), imported: statement, passesOn: false };
  }
  const element = bindings.elements.find((each) => (each.propertyName ?? each.name).text === named.name);
  return element && { source, reads: readsIn(source, element.name.text), others: [], imported: element, passesOn: false };
}

/** Every file of the project that reads `named`, by its own name or through an import of its file. */
function readersOf(project: ProjectSource, named: Named): Reader[] {
  const declaration = ts.isVariableStatement(named.statement) ? named.statement.declarationList.declarations[0] : named.statement;
  const readers: Reader[] = [
    { source: named.source, reads: readsIn(named.source, named.name, declaration), others: [], passesOn: false },
  ];
  for (const { source, statement } of importsOf(project, named.source)) {
    const reader = ts.isImportDeclaration(statement)
      ? importReader(source, statement, named)
      : { source, reads: [], others: [], passesOn: true };
    if (reader) readers.push(reader);
  }
  return readers;
}

/** One plan in the making: what goes, and what could not be followed. */
class Removal {
  readonly changes: SaveChange[] = [];
  private readonly cut = new Map<Part, ts.SourceFile>();
  /** The files that define what was removed. */
  private readonly homes = new Set<ts.SourceFile>();

  constructor(private readonly project: ProjectSource) {}

  private lineOf(node: ts.Node, source: ts.SourceFile): number {
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  }

  private note(kind: SaveChange['kind'], of: string, status: SaveChange['status'], at?: { node: ts.Node; source: ts.SourceFile }) {
    this.changes.push({
      kind,
      of,
      setting: '',
      status,
      ...(at ? { file: at.source.fileName, line: this.lineOf(at.node, at.source) } : {}),
    });
  }

  /**
   * What a read of a name is there for, when taking it out leaves nothing behind: a statement
   * that registers it, a statement that calls it when it is a function, or its entry in the
   * setup's `questions`.
   */
  private useOf(read: ts.Identifier, source: ts.SourceFile, callable = false): Part | undefined {
    let value: ts.Node = read;
    // `module.profile` and `module.structured.id` are reads of what the module holds.
    while (ts.isPropertyAccessExpression(value.parent) && value.parent.expression === value) value = value.parent;
    value = wrapped(value);
    const { parent } = value;
    if (ts.isCallExpression(parent)) {
      const registers = parent.arguments.includes(value as ts.Expression) && REGISTERS.has(calleeName(parent) ?? '');
      const called = callable && parent.expression === value;
      return registers || called ? statementOf(parent) : undefined;
    }
    const questions = questionsExport(source)?.initializer;
    const entry = ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === value);
    return entry && questions && parent.parent === unwrapped(questions) ? parent : undefined;
  }

  /**
   * Takes a named definition out of every file that only registers it. True when a statement that
   * registers it was found. The definition itself goes when nothing else reads it.
   */
  private named(named: Named): boolean {
    const readers = readersOf(this.project, named);
    const callable = ts.isFunctionDeclaration(named.statement);
    const uses = readers.map((reader) => reader.reads.map((read) => this.useOf(read, reader.source, callable)));
    const registering = uses.flat().filter((use) => use !== undefined && ts.isExpressionStatement(use));
    if (!registering.length) return false;
    // A module that defines one profile holds what goes with it: its reply's shape, its questions.
    const alone = !callable && this.definedIn(named.source) === 1;
    let kept = false;
    readers.forEach((reader, index) => {
      const held = uses[index] ?? [];
      for (const use of held) if (use) this.cut.set(use, reader.source);
      const beside = reader.others.map((read) => (alone ? this.useOf(read, reader.source) : undefined));
      const whole = !reader.passesOn && [...held, ...beside].every((use) => use !== undefined);
      if (whole) for (const use of beside) if (use) this.cut.set(use, reader.source);
      if (whole && reader.imported) this.unimport(reader.imported, reader.source);
      if (!held.every((use) => use !== undefined) || reader.passesOn) kept = true;
    });
    if (!kept) this.cut.set(named.statement, named.source);
    return true;
  }

  /** How many profiles a file defines. */
  private definedIn(source: ts.SourceFile): number {
    let count = 0;
    for (const targets of this.project.profiles.values()) count += targets.filter((target) => target.source === source).length;
    return count;
  }

  /** An import's name goes, and the import with it when that was all it brought in. */
  private unimport(imported: ts.ImportSpecifier | ts.ImportDeclaration, source: ts.SourceFile) {
    if (ts.isImportDeclaration(imported)) {
      this.cut.set(imported, source);
      return;
    }
    this.cut.set(imported, source);
    const names = imported.parent;
    const statement = names.parent.parent;
    if (!ts.isImportDeclaration(statement)) return;
    const alone = !statement.importClause?.name && names.elements.every((element) => this.cut.has(element));
    if (alone) this.cut.set(statement, source);
  }

  profile(id: string) {
    const targets = this.project.profiles.get(id) ?? [];
    const [target] = targets;
    if (!target) return this.note('profile', id, 'removed');
    const at = { node: target.options, source: target.source };
    // Written twice: the studio cannot tell which one runs.
    if (targets.length > 1) return this.note('profile', id, 'removed', at);
    const defined = wrapped(target.options).parent;
    const outer = wrapped(defined).parent;
    const inline = ts.isCallExpression(outer) && calleeName(outer) === 'registerProfile' ? statementOf(outer) : undefined;
    const named = inline ? undefined : declared(defined, target.source);
    if (inline) this.cut.set(inline, target.source);
    else if (!named || !this.named(named)) return this.note('profile', id, 'removed', at);
    this.homes.add(target.source);
    this.unasked(id);
    this.note('profile', id, 'written', at);
  }

  /** A removed decision's entry in the setup's `questions`, under its id. */
  private unasked(id: string) {
    for (const source of this.project.files.values()) {
      const held = questionsExport(source)?.initializer;
      const questions = held && unwrapped(held);
      if (!questions || !ts.isObjectLiteralExpression(questions)) continue;
      const entry = questions.properties.find((property) => propertyName(property) === id);
      if (entry) this.cut.set(entry, source);
    }
  }

  tool(name: string) {
    const targets = this.project.tools.get(name) ?? [];
    const [target] = targets;
    if (!target) return this.note('tool', name, 'removed');
    const at = { node: target.options, source: target.source };
    if (targets.length > 1) return this.note('tool', name, 'removed', at);
    const statement = statementOf(wrapped(target.options).parent);
    if (!statement) return this.note('tool', name, 'removed', at);
    // A function that only registers this tool goes with its calls. One nothing here calls is the
    // setup's own, and keeps its name.
    const register = wholeBodyOf(statement, target.source);
    if (!register || !this.named(register)) this.cut.set(statement, target.source);
    this.homes.add(target.source);
    this.note('tool', name, 'written', at);
  }

  private within(part: Part): boolean {
    for (let at = part.parent; at; at = at.parent) if (this.cut.has(at as Part)) return true;
    return false;
  }

  /**
   * A file that defined what was removed and that the project no longer reads: nothing imports it
   * now, and either something did before or nothing of its own is left in it.
   */
  private isGone(source: ts.SourceFile): boolean {
    if (source.fileName === this.project.entry || !this.homes.has(source)) return false;
    let imported = false;
    for (const { statement } of importsOf(this.project, source)) {
      if (!this.cut.has(statement)) return false;
      imported = true;
    }
    const own = source.statements.filter((statement) => !ts.isImportDeclaration(statement));
    return imported || (own.length > 0 && own.every((statement) => this.cut.has(statement)));
  }

  /** An import of a file only for what running it registers goes when the file registers nothing now. */
  private unrun() {
    for (const home of this.homes) {
      const own = home.statements.filter((statement) => !ts.isImportDeclaration(statement));
      if (!own.length || !own.every((statement) => this.cut.has(statement))) continue;
      for (const { source, statement } of importsOf(this.project, home)) {
        if (ts.isImportDeclaration(statement) && !statement.importClause) this.cut.set(statement, source);
      }
    }
  }

  build(): RemovalPlan {
    this.unrun();
    const gone = [...this.project.files.values()].filter((source) => this.isGone(source));
    const parts = new Map<ts.SourceFile, Part[]>();
    for (const [part, source] of this.cut) {
      if (gone.includes(source) || this.within(part)) continue;
      parts.set(source, [...(parts.get(source) ?? []), part]);
    }
    const edits = [...parts].flatMap(([source, held]) =>
      cutsOf(held, source).map(({ start, end }): SourceEdit => ({ file: source.fileName, start, end, text: '' }))
    );
    return { changes: this.changes, edits, gone: gone.map((source) => source.fileName) };
  }
}

const BLANK = /^[ \t]*$/;

/** A stretch of a file to take out. `lines` when it is whole lines. */
interface Cut {
  start: number;
  end: number;
  lines: boolean;
}

/** The comments right above a part, with no blank line between: they are about it, and go with it. */
function withComments(part: Part, source: ts.SourceFile): number {
  let start = part.getStart(source);
  const comments = ts.getLeadingCommentRanges(source.text, part.getFullStart()) ?? [];
  for (const comment of comments.toReversed()) {
    const between = source.text.slice(comment.end, start);
    if (between.trim() !== '' || between.split('\n').length > 2) break;
    start = comment.pos;
  }
  return start;
}

/** The lines a part fills, when nothing else is written on them. A listed part's comma is its own. */
function ownLines(part: Part, source: ts.SourceFile): Cut | undefined {
  const { text } = source;
  const start = withComments(part, source);
  const end = !ts.isStatement(part) && text[part.end] === ',' ? part.end + 1 : part.end;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const next = text.indexOf('\n', end);
  const lineEnd = next === -1 ? text.length : next;
  if (!BLANK.test(text.slice(lineStart, start)) || !BLANK.test(text.slice(end, lineEnd))) return undefined;
  return { start: lineStart, end: next === -1 ? text.length : next + 1, lines: true };
}

/** The list a part is one entry of: an object's properties, or an import's names. */
function listOf(part: Part): readonly Part[] | undefined {
  if (ts.isImportSpecifier(part)) return part.parent.elements;
  if (ts.isStatement(part)) return undefined;
  return ts.isObjectLiteralExpression(part.parent) ? part.parent.properties : undefined;
}

/**
 * The cut for entries that share their line with others: up to the entry that follows them, or
 * back to the one before when they are last, so the commas left are the ones the list needs.
 */
function inList(list: readonly Part[], first: number, last: number, source: ts.SourceFile): Cut {
  const [from, to, after, before] = [list[first], list[last], list[last + 1], list[first - 1]];
  if (!from || !to) throw new Error('A cut names an entry its list does not hold.');
  if (after) return { start: from.getStart(source), end: after.getStart(source), lines: false };
  if (before) return { start: before.end, end: to.end, lines: false };
  const end = source.text[to.end] === ',' ? to.end + 1 : to.end;
  return { start: from.getStart(source), end, lines: false };
}

/** One blank line stays between what was above a cut and what was below it, not two. */
function closed(cut: Cut, text: string): Cut {
  if (!cut.lines) return cut;
  const above = cut.start === 0 || BLANK.test(text.slice(text.lastIndexOf('\n', cut.start - 2) + 1, cut.start - 1));
  const next = text.indexOf('\n', cut.end);
  const below = next !== -1 && BLANK.test(text.slice(cut.end, next));
  return above && below ? { ...cut, end: next + 1 } : cut;
}

/** What to take out of one file for the parts cut from it: no two cuts touch. */
function cutsOf(parts: readonly Part[], source: ts.SourceFile): Cut[] {
  const cuts: Cut[] = [];
  const listed = new Map<readonly Part[], Part[]>();
  for (const part of parts) {
    const own = ownLines(part, source);
    const list = own ? undefined : listOf(part);
    if (own) cuts.push(own);
    else if (list) listed.set(list, [...(listed.get(list) ?? []), part]);
    else cuts.push({ start: withComments(part, source), end: part.end, lines: false });
  }
  for (const [list, held] of listed) {
    const at = held.map((part) => list.indexOf(part)).sort((a, b) => a - b);
    for (let index = 0; index < at.length; index++) {
      const first = at[index] ?? 0;
      while (at[index + 1] === (at[index] ?? 0) + 1) index++;
      cuts.push(inList(list, first, at[index] ?? first, source));
    }
  }
  cuts.sort((a, b) => a.start - b.start);
  const joined: Cut[] = [];
  for (const cut of cuts) {
    const last = joined.at(-1);
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else joined.push({ ...cut });
  }
  return joined.map((cut) => closed(cut, source.text));
}

/** Plans the removal of each profile and tool the studio took away. */
export function planRemoved(project: ProjectSource, removed: Removed): RemovalPlan {
  const removal = new Removal(project);
  for (const id of removed.profiles) removal.profile(id);
  for (const name of removed.tools) removal.tool(name);
  return removal.build();
}
