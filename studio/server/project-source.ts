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
export function followed(project: ProjectSource, at: Located, depth = 0): Located {
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
  const declared = constant(at.source, node.text);
  if (declared) return followed(project, { node: declared, source: at.source }, depth + 1);
  const from = importOf(at.source, node.text);
  if (!from) return { node, source: at.source };
  const file = importedFile(at.source.fileName, from.specifier, (path) => project.files.has(path), project.root);
  const source = file ? project.files.get(file) : undefined;
  const exported = source && constant(source, from.name);
  if (!source || !exported) return { node, source: at.source };
  return followed(project, { node: exported, source }, depth + 1);
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
