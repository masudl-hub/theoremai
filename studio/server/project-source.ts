/**
 * The project's own source, read as syntax: where each `defineProfile` and
 * `registerTool` call is written, so Save can change a value in the builder's
 * file. It starts at the setup module and follows the project's relative
 * imports. Nothing is loaded or run.
 *
 * @module
 */

import ts from 'typescript';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { SharedSetting } from './save-wire.ts';

/** One call the studio can write to: its options object, in its file. */
export interface SourceTarget {
  file: string;
  source: ts.SourceFile;
  options: ts.ObjectLiteralExpression;
}

export interface ProjectSource {
  /** The folder the studio may write in. */
  root: string;
  /** Each file read, by absolute path. */
  files: Map<string, ts.SourceFile>;
  /** The `defineProfile` calls, by profile id. An id written twice has two. */
  profiles: Map<string, SourceTarget[]>;
  /** The `registerTool` calls, by tool name. */
  tools: Map<string, SourceTarget[]>;
}

/** An expression in the file that holds it. */
export interface Located {
  node: ts.Expression;
  source: ts.SourceFile;
}

export type ReadFile = (path: string) => string | undefined;

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/mod.ts'];

/** Whether `path` is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
  const from = relative(root, path);
  return from === '' || (!from.startsWith('..') && !isAbsolute(from));
}

/** The file a relative import names, or undefined when it is not one of the project's. */
function importedFile(from: string, specifier: string, exists: (path: string) => boolean, root: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const base = resolve(dirname(from), specifier);
  // `./tools.js` in a TypeScript project names `./tools.ts`.
  const bases = /\.[cm]?js$/.test(base) ? [base, base.replace(/\.([cm]?)js$/, '.$1ts')] : [base];
  for (const candidate of bases) {
    for (const extension of EXTENSIONS) {
      const path = candidate + extension;
      if (!isInside(root, path) || path.includes('/node_modules/')) continue;
      if (exists(path)) return path;
    }
  }
  return undefined;
}

/** `expression` without the wrappers that do not change its value. */
export function unwrapped(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)
  ) node = node.expression;
  return node;
}

/** The name a property is written under, when it is a plain one. */
export function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const { name } = property;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** The module specifier of each import, export-from and literal `import()` in a file. */
function specifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
    ) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What a call is named: `defineProfile(...)` and `theorem.defineProfile(...)` are both `defineProfile`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/**
 * Follows a name to the expression it stands for: a `const` in the same file, or one a relative
 * import brings in. Anything else (a parameter, a `let`, a package's export) stays as it is.
 */
function followed(project: ProjectSource, at: Located, depth = 0): Located {
  const node = unwrapped(at.node);
  if (depth > 8) return { node, source: at.source };
  if (ts.isPropertyAccessExpression(node)) {
    const owner = followed(project, { node: node.expression, source: at.source }, depth + 1);
    if (!ts.isObjectLiteralExpression(owner.node)) return { node, source: at.source };
    const held = owner.node.properties.find((property) => propertyName(property) === node.name.text);
    if (!held || !ts.isPropertyAssignment(held)) return { node, source: at.source };
    return followed(project, { node: held.initializer, source: owner.source }, depth + 1);
  }
  if (!ts.isIdentifier(node)) return { node, source: at.source };
  const binding = bindingOf(project, at.source, node.text);
  if (!binding) return { node, source: at.source };
  return followed(project, { node: binding.initializer, source: binding.source }, depth + 1);
}

/** A top-level `const` of the project: its name where it is declared, its file, and what it is set to. */
export interface Binding {
  name: string;
  source: ts.SourceFile;
  initializer: ts.Expression;
}

/** The file of the project a relative import in `source` names. */
function sourceOf(project: ProjectSource, source: ts.SourceFile, specifier: string): ts.SourceFile | undefined {
  const file = importedFile(source.fileName, specifier, (path) => project.files.has(path), project.root);
  return file ? project.files.get(file) : undefined;
}

/** The constant a name in `source` stands for: one declared there, or one a relative import brings in. */
function bindingOf(project: ProjectSource, source: ts.SourceFile, name: string): Binding | undefined {
  const declared = constant(source, name);
  if (declared) return { name, source, initializer: declared };
  const from = importOf(source, name);
  const origin = from && sourceOf(project, source, from.specifier);
  const exported = origin && from && constant(origin, from.name);
  return origin && from && exported ? { name: from.name, source: origin, initializer: exported } : undefined;
}

/** The constant whose value holds `at`: the top-level `const` it is written inside. */
function holderOf(at: Located): Binding | undefined {
  for (const statement of at.source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (!initializer || !ts.isIdentifier(name)) continue;
      if (initializer.pos <= at.node.pos && at.node.end <= initializer.end) {
        return { name: name.text, source: at.source, initializer };
      }
    }
  }
  return undefined;
}

/**
 * Where a name's value is written, and the constant that holds it. No holder when the name could
 * not be followed to a constant: an argument, a call, a module the project does not own.
 */
export function namedValue(project: ProjectSource, at: Located): { origin: Located; holder?: Binding } {
  const origin = followed(project, at);
  return { origin, holder: origin.node === unwrapped(at.node) ? undefined : holderOf(origin) };
}

/** Whether an identifier reads a value: not a declaration's name, a property's name, an import, or a type. */
function isRead(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isTypeNode(parent)) return false;
  return (parent as { name?: ts.Node }).name !== node;
}

/** The name `source` knows a constant by: its own, or the one an import gives it. */
function localName(project: ProjectSource, source: ts.SourceFile, binding: Binding): string | undefined {
  if (source === binding.source) return binding.name;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find((each) => (each.propertyName ?? each.name).text === binding.name);
    if (element && sourceOf(project, source, statement.moduleSpecifier.text) === binding.source) return element.name.text;
  }
  return undefined;
}

/** Each place the project's code reads a constant. */
function readsOf(project: ProjectSource, binding: Binding): Located[] {
  const reads: Located[] = [];
  for (const source of project.files.values()) {
    const name = localName(project, source, binding);
    if (name === undefined) continue;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name && isRead(node)) reads.push({ node, source });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return reads;
}

/** Who a constant's value reaches: the profiles and tools, and whether other code reads it too. */
export interface ConstantUsers {
  profiles: Set<string>;
  tools: Set<string>;
  /** Code that is not a profile, a tool or another constant reads it. */
  code: boolean;
}

/** Whether `node` is part of the value `value` writes out, not something a function or a call inside it reads. */
function isWrittenIn(node: ts.Node, value: ts.Expression): boolean {
  for (let at = node.parent; at !== value.parent; at = at.parent) {
    const data = ts.isObjectLiteralExpression(at) || ts.isArrayLiteralExpression(at) ||
      ts.isPropertyAssignment(at) || ts.isShorthandPropertyAssignment(at) || ts.isSpreadAssignment(at) ||
      ts.isSpreadElement(at) || ts.isPropertyAccessExpression(at) || ts.isParenthesizedExpression(at) ||
      ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isNonNullExpression(at);
    if (!data) return false;
  }
  return true;
}

/** The profile or tool whose options write `at` out as a value. A read inside a handler is code. */
function targetOf(targets: Map<string, SourceTarget[]>, at: Located): string | undefined {
  for (const [name, held] of targets) {
    const inside = held.some(({ source, options }) =>
      source === at.source && options.pos <= at.node.pos && at.node.end <= options.end &&
      isWrittenIn(at.node, options)
    );
    if (inside) return name;
  }
  return undefined;
}

/**
 * Follows a constant to everything it sets: a profile or tool that reads it, and through a
 * constant that reads it, whatever reads that one.
 */
export function usersOf(project: ProjectSource, binding: Binding): ConstantUsers {
  const users: ConstantUsers = { profiles: new Set(), tools: new Set(), code: false };
  const seen = new Set<ts.Expression>();
  const follow = (each: Binding) => {
    if (seen.has(each.initializer)) return;
    seen.add(each.initializer);
    for (const read of readsOf(project, each)) {
      const profile = targetOf(project.profiles, read);
      const tool = profile === undefined ? targetOf(project.tools, read) : undefined;
      const held = profile === undefined && tool === undefined ? holderOf(read) : undefined;
      const holder = held && isWrittenIn(read.node, held.initializer) ? held : undefined;
      if (profile !== undefined) users.profiles.add(profile);
      else if (tool !== undefined) users.tools.add(tool);
      else if (holder) follow(holder);
      else users.code = true;
    }
  };
  follow(binding);
  return users;
}

/** Each top-level `const` of a file that is set to a value, not a function. */
function constantsOf(source: ts.SourceFile): Binding[] {
  const found: Binding[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (!initializer || !ts.isIdentifier(name)) continue;
      const value = unwrapped(initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) continue;
      found.push({ name: name.text, source, initializer });
    }
  }
  return found;
}

/** `STANDARD_GUARDRAILS` and `standardGuardrails` as "Standard guardrails". */
export function readableName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean)
    .map((word) => word.toLowerCase());
  const text = words.join(' ');
  return text ? text[0]?.toUpperCase() + text.slice(1) : name;
}

/**
 * The profile key a constant fills: set when every read of it is the whole value of that one key,
 * written in a profile's own options. A constant read any other way has none.
 */
function wholeKey(project: ProjectSource, binding: Binding): string | undefined {
  const keys = new Set<string | undefined>();
  for (const read of readsOf(project, binding)) {
    let value: ts.Node = read.node;
    while (
      ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) ||
      ts.isSatisfiesExpression(value.parent)
    ) value = value.parent;
    const held = value.parent;
    const whole = ts.isShorthandPropertyAssignment(held) || (ts.isPropertyAssignment(held) && held.initializer === value);
    const own = whole && [...project.profiles.values()].flat().some((target) => target.options === held.parent);
    keys.add(own ? propertyName(held as ts.ObjectLiteralElementLike) : undefined);
  }
  const [key] = keys;
  return keys.size === 1 ? key : undefined;
}

/**
 * The project's shared settings: each constant that more than one profile or tool reads, with
 * who reads it. One that a single profile reads is a part of that profile, and is not listed.
 */
export function sharedSettings(project: ProjectSource): SharedSetting[] {
  const shared: SharedSetting[] = [];
  for (const source of project.files.values()) {
    for (const binding of constantsOf(source)) {
      const users = usersOf(project, binding);
      if (users.profiles.size + users.tools.size < 2) continue;
      const key = users.code || users.tools.size ? undefined : wholeKey(project, binding);
      shared.push({
        name: binding.name,
        label: readableName(binding.name),
        file: source.fileName,
        line: source.getLineAndCharacterOfPosition(binding.initializer.parent.getStart(source)).line + 1,
        ...(key === undefined ? {} : { key }),
        profiles: [...users.profiles],
        tools: [...users.tools],
        readByCode: users.code,
      });
    }
  }
  return shared;
}

/** The initializer of the one top-level `const name = ...` in a file. */
function constant(source: ts.SourceFile, name: string): ts.Expression | undefined {
  const found: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        found.push(declaration.initializer);
      }
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Where a file imports `name` from, and what it is called there. */
function importOf(source: ts.SourceFile, name: string): { specifier: string; name: string } | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue;
      return { specifier: statement.moduleSpecifier.text, name: (element.propertyName ?? element.name).text };
    }
  }
  return undefined;
}

/** The text a property of `options` holds, following a constant; undefined when it is not plain text. */
function textOf(project: ProjectSource, target: SourceTarget, key: string): string | undefined {
  const held = target.options.properties.find((property) => propertyName(property) === key);
  if (!held || !ts.isPropertyAssignment(held)) return undefined;
  const { node } = followed(project, { node: held.initializer, source: target.source });
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Reads the project from `entry`, the setup module. `read` returns a file's text, or undefined. */
export function readProjectSource(entry: string, root: string, read: ReadFile): ProjectSource {
  const project: ProjectSource = { root, files: new Map(), profiles: new Map(), tools: new Map() };
  const queue = [resolve(entry)];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (project.files.has(path)) continue;
    const text = read(path);
    if (text === undefined) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    project.files.set(path, source);
    for (const specifier of specifiers(source)) {
      const next = importedFile(path, specifier, (file) => read(file) !== undefined, root);
      if (next && !project.files.has(next)) queue.push(next);
    }
  }
  const calls: Array<{ into: Map<string, SourceTarget[]>; key: string; target: SourceTarget }> = [];
  for (const [file, source] of project.files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments[0]) {
        const name = calleeName(node);
        const options = unwrapped(node.arguments[0]);
        if (ts.isObjectLiteralExpression(options)) {
          const target = { file, source, options };
          if (name === 'defineProfile') calls.push({ into: project.profiles, key: 'id', target });
          if (name === 'registerTool') calls.push({ into: project.tools, key: 'name', target });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Every file is read before a name is followed, so a constant from another file is found.
  for (const { into, key, target } of calls) {
    const named = textOf(project, target, key);
    if (named !== undefined) into.set(named, [...(into.get(named) ?? []), target]);
  }
  return project;
}
