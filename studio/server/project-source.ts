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
  /** Set when a function of the project makes the call: what its parameters stand for, for this profile. */
  env?: Env;
  /** That function's call for this profile. What its arguments write is this profile's alone. */
  call?: { node: ts.CallExpression; source: ts.SourceFile };
}

/** What a function's parameters stand for in one call of it. */
export interface Env {
  /** Each parameter's argument, where the call writes it. Undefined when the call gives none. */
  bound: ReadonlyMap<string, Located | undefined>;
  /** How many calls deep this one is. */
  depth: number;
}

export interface ProjectSource {
  /** The folder the studio may write in. */
  root: string;
  /** The setup module, where reading starts. */
  entry: string;
  /** Each file read, by absolute path, the setup module first. */
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
  /** Set inside a function the studio followed a call into. */
  env?: Env;
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

/** The setup module's `export const questions`, when it writes one. */
export function questionsExport(source: ts.SourceFile): ts.VariableDeclaration | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const found = statement.declarationList.declarations.find((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'questions'
    );
    if (found) return found;
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
export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** How far a name is followed, through constants and calls. */
const MAX_DEPTH = 8;

/** A value the files leave out: a key an object does not write, a parameter a call gives no argument. */
const MISSING = Symbol('missing');

/** A function of the project that only returns a value. */
interface ProjectFunction {
  name: string;
  source: ts.SourceFile;
  parameters: readonly string[];
  /** A parameter's own default, by its place. */
  defaults: readonly (ts.Expression | undefined)[];
  /** What it returns. */
  value: ts.Expression;
}

/** What a function returns, when returning it is all the function does. */
function returned(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const { body } = fn;
  const plainCall = !fn.asteriskToken && !fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (!body || !plainCall) return undefined;
  if (!ts.isBlock(body)) return body;
  const [only] = body.statements;
  return body.statements.length === 1 && only && ts.isReturnStatement(only) ? only.expression : undefined;
}

/** `fn` as a function the studio follows: plain parameters, and one value returned. */
function followable(name: string, source: ts.SourceFile, fn: ts.FunctionLikeDeclaration): ProjectFunction | undefined {
  const value = returned(fn);
  if (!value || fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken)) {
    return undefined;
  }
  return {
    name,
    source,
    parameters: fn.parameters.map((parameter) => (parameter.name as ts.Identifier).text),
    defaults: fn.parameters.map((parameter) => parameter.initializer),
    value,
  };
}

/** Each top-level function of a file: a declaration, or a `const` set to one. */
function functionsOf(source: ts.SourceFile): Array<{ name: string; fn: ts.FunctionLikeDeclaration }> {
  const found: Array<{ name: string; fn: ts.FunctionLikeDeclaration }> = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) found.push({ name: statement.name.text, fn: statement });
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      const value = initializer && unwrapped(initializer);
      if (value && ts.isIdentifier(name) && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
        found.push({ name: name.text, fn: value });
      }
    }
  }
  return found;
}

/** The function a name in `source` calls: one declared there, or one a relative import brings in. */
function functionOf(project: ProjectSource, source: ts.SourceFile, name: string): ProjectFunction | undefined {
  const declared = (file: ts.SourceFile, called: string) => {
    const held = functionsOf(file).filter((each) => each.name === called);
    return held.length === 1 && held[0] ? followable(called, file, held[0].fn) : undefined;
  };
  const here = declared(source, name);
  if (here) return here;
  const from = importOf(source, name);
  const origin = from && sourceOf(project, source, from.specifier);
  return origin && from ? declared(origin, from.name) : undefined;
}

/** What a call of a project function returns, with its parameters standing for the call's arguments. */
function calledValue(project: ProjectSource, call: ts.CallExpression, at: Located): Located | undefined {
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || at.env?.bound.has(callee.text)) return undefined;
  const depth = (at.env?.depth ?? 0) + 1;
  const fn = depth > MAX_DEPTH ? undefined : functionOf(project, at.source, callee.text);
  if (!fn || call.arguments.some(ts.isSpreadElement)) return undefined;
  const bound = new Map<string, Located | undefined>();
  fn.parameters.forEach((name, index) => {
    const argument = call.arguments[index];
    const preset = fn.defaults[index];
    if (argument) bound.set(name, { node: argument, source: at.source, env: at.env });
    else bound.set(name, preset ? { node: preset, source: fn.source } : undefined);
  });
  return { node: fn.value, source: fn.source, env: { bound, depth } };
}

/** A provider's `model(apiId, settings)`: it returns the settings with the provider's id and the API id. */
export function isModelCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'model' && (node.arguments.length === 1 || node.arguments.length === 2) &&
    !node.arguments.some(ts.isSpreadElement);
}

/** What a call stands for, when the studio reads through it: `defineProfile`'s options, a project function's value. */
function seenThrough(project: ProjectSource, call: ts.CallExpression, at: Located): Located | undefined {
  const [first] = call.arguments;
  if (calleeName(call) === 'defineProfile' && call.arguments.length === 1 && first && !ts.isSpreadElement(first)) {
    return { node: first, source: at.source, env: at.env };
  }
  return calledValue(project, call, at);
}

/** One key of an object, as the files write it. */
export interface ShapeEntry {
  key: string;
  /** What the key is set to. Undefined when the files write it as a method, or cannot say. */
  value?: Located;
  /** The property that writes it. Undefined for what a call's own arguments set. */
  property?: ts.ObjectLiteralElementLike;
  /** The file that writes it. */
  source: ts.SourceFile;
}

/** An object as the files write it out: its own keys, and those of each object it spreads in. */
export interface ObjectShape {
  /** Each key by name, in the order written. The last one written of a name is the one held. */
  entries: Map<string, ShapeEntry>;
  /** A spread or a computed key the studio could not follow. Only the keys written `after` it are sure. */
  open?: { node: ts.Node; source: ts.SourceFile; after: Set<string> };
  /** The literal a new key is written in. */
  own?: { node: ts.ObjectLiteralExpression; source: ts.SourceFile };
}

/** The name a property is written under: a plain one, or a computed one that names a constant's text. */
function keyOf(project: ProjectSource, property: ts.ObjectLiteralElementLike, at: Located, depth: number): string | undefined {
  const plainName = propertyName(property);
  if (plainName !== undefined || !property.name || !ts.isComputedPropertyName(property.name)) return plainName;
  const held = step(project, { node: property.name.expression, source: at.source, env: at.env }, depth + 1);
  if (held === MISSING) return undefined;
  return ts.isStringLiteralLike(held.node) || ts.isNumericLiteral(held.node) ? held.node.text : undefined;
}

/** Where a provider's id is written: the `id` of the `defineProvider` call the name stands for. */
function providerId(project: ProjectSource, at: Located, depth: number): Located | undefined {
  const held = step(project, at, depth + 1);
  if (held === MISSING || !ts.isCallExpression(held.node) || calleeName(held.node) !== 'defineProvider') return undefined;
  const [options] = held.node.arguments;
  const id = options && ts.isObjectLiteralExpression(options)
    ? options.properties.findLast((property) => propertyName(property) === 'id')
    : undefined;
  return id && ts.isPropertyAssignment(id) ? { node: id.initializer, source: held.source, env: held.env } : undefined;
}

/**
 * The object an expression writes out: an object literal, or a provider's `model()` call. Each
 * spread is followed to the object it names. Undefined for anything else.
 */
export function shapeOf(project: ProjectSource, at: Located, depth = 0): ObjectShape | undefined {
  const node = unwrapped(at.node);
  if (depth > MAX_DEPTH || !(ts.isObjectLiteralExpression(node) || isModelCall(node))) return undefined;
  const shape: ObjectShape = { entries: new Map() };
  const inside = (inner: ts.Expression): Located => ({ node: inner, source: at.source, env: at.env });
  const put = (entry: ShapeEntry) => {
    shape.entries.delete(entry.key);
    shape.entries.set(entry.key, entry);
    shape.open?.after.add(entry.key);
  };
  const spread = (from: ts.Expression, written: ts.Node) => {
    const inner = step(project, inside(from), depth + 1);
    // A spread of nothing adds nothing.
    if (inner === MISSING) return;
    const held = shapeOf(project, inner, depth + 1);
    if (!held) {
      shape.open = { node: written, source: at.source, after: new Set() };
      return;
    }
    const sure = held.open?.after;
    if (held.open) shape.open = { ...held.open, after: new Set() };
    for (const entry of held.entries.values()) {
      shape.entries.delete(entry.key);
      shape.entries.set(entry.key, entry);
      if (!sure || sure.has(entry.key)) shape.open?.after.add(entry.key);
    }
  };
  if (ts.isObjectLiteralExpression(node)) {
    shape.own = { node, source: at.source };
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        spread(property.expression, property);
        continue;
      }
      const key = keyOf(project, property, at, depth);
      if (key === undefined) {
        shape.open = { node: property, source: at.source, after: new Set() };
        continue;
      }
      const value = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
      put({ key, property, source: at.source, ...(value ? { value: inside(value) } : {}) });
    }
    return shape;
  }
  const [apiId, settings] = node.arguments;
  if (settings) {
    spread(settings, settings);
    const direct = unwrapped(settings);
    if (ts.isObjectLiteralExpression(direct)) shape.own = { node: direct, source: at.source };
  }
  const provider = providerId(project, inside((node.expression as ts.PropertyAccessExpression).expression), depth);
  put({ key: 'provider', source: at.source, ...(provider ? { value: provider } : {}) });
  if (apiId) put({ key: 'apiId', source: at.source, value: inside(apiId) });
  return shape;
}

/** Whether an expression writes a value that is surely there: not `undefined`, not `null`. */
function isWritten(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) || node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword || isModelCall(node);
}

/** One expression followed as far as the files say what it is, or `MISSING` when they say it is not there. */
function step(project: ProjectSource, at: Located, depth: number): Located | typeof MISSING {
  const node = unwrapped(at.node);
  const here: Located = { ...at, node };
  if (depth > MAX_DEPTH) return here;
  const inside = (inner: ts.Expression): Located => ({ node: inner, source: at.source, env: at.env });
  if (ts.isPropertyAccessExpression(node)) {
    const owner = step(project, inside(node.expression), depth + 1);
    const shape = owner === MISSING ? undefined : shapeOf(project, owner, depth + 1);
    if (!shape) return here;
    const held = shape.entries.get(node.name.text);
    if (shape.open && !(held && shape.open.after.has(held.key))) return here;
    if (!held) return MISSING;
    return held.value ? step(project, held.value, depth + 1) : here;
  }
  if (ts.isIdentifier(node)) {
    if (at.env?.bound.has(node.text)) {
      const argument = at.env.bound.get(node.text);
      return argument ? step(project, argument, depth + 1) : MISSING;
    }
    const binding = bindingOf(project, at.source, node.text);
    return binding ? step(project, { node: binding.initializer, source: binding.source }, depth + 1) : here;
  }
  if (ts.isCallExpression(node)) {
    const seen = seenThrough(project, node, at);
    return seen ? step(project, seen, depth + 1) : here;
  }
  if (ts.isConditionalExpression(node)) {
    // A condition the files write out as true or false picks its side.
    const when = step(project, inside(node.condition), depth + 1);
    const truth = when === MISSING
      ? false
      : when.node.kind === ts.SyntaxKind.TrueKeyword
      ? true
      : when.node.kind === ts.SyntaxKind.FalseKeyword
      ? false
      : undefined;
    return truth === undefined ? here : step(project, inside(truth ? node.whenTrue : node.whenFalse), depth + 1);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = step(project, inside(node.left), depth + 1);
    if (left === MISSING) return step(project, inside(node.right), depth + 1);
    return isWritten(left.node) ? left : here;
  }
  const [only] = ts.isArrayLiteralExpression(node) ? node.elements : [];
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 1 && only && ts.isSpreadElement(only)) {
    // A copy of one list is that list.
    const copied = step(project, inside(only.expression), depth + 1);
    return copied !== MISSING && ts.isArrayLiteralExpression(copied.node) ? copied : here;
  }
  return here;
}

/**
 * Follows an expression to what it stands for: a `const` in the same file or one a relative
 * import brings in, a key of an object, an argument of a call, what a project function returns.
 * Anything else (a `let`, a package's export, code that computes) stays as it is.
 */
export function followed(project: ProjectSource, at: Located): Located {
  const held = step(project, at, 0);
  return held === MISSING ? { ...at, node: unwrapped(at.node) } : held;
}

/** A top-level `const` of the project: its name where it is declared, its file, and what it is set to. */
export interface Binding {
  name: string;
  source: ts.SourceFile;
  initializer: ts.Expression;
  /** Set for a function: `initializer` is what it returns. */
  returns?: true;
}

/** The file of the project a relative import in `source` names. */
export function sourceOf(project: ProjectSource, source: ts.SourceFile, specifier: string): ts.SourceFile | undefined {
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

/**
 * The constant whose value holds `at`: the top-level `const` it is written inside. A function that
 * only returns a value holds what it returns, as a constant does.
 */
export function holderOf(at: Located): Binding | undefined {
  const holds = (value: ts.Node) => value.pos <= at.node.pos && at.node.end <= value.end;
  for (const { name, fn } of functionsOf(at.source)) {
    if (!holds(fn)) continue;
    const value = returned(fn);
    return value && holds(value) ? { name, source: at.source, initializer: value, returns: true } : undefined;
  }
  for (const statement of at.source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (!initializer || !ts.isIdentifier(name)) continue;
      if (holds(initializer)) return { name: name.text, source: at.source, initializer };
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
  return { origin, holder: origin.node === unwrapped(at.node) && origin.source === at.source ? undefined : holderOf(origin) };
}

/** Whether an identifier reads a value: not a declaration's name, a property's name, an import, or a type. */
export function isRead(node: ts.Identifier): boolean {
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

/** Whether a call writes `child` out: an argument of a call the studio reads through, or the project function called. */
function passes(project: ProjectSource, call: ts.CallExpression, child: ts.Node): boolean {
  const callee = call.expression;
  const ours = ts.isIdentifier(callee) && functionOf(project, call.getSourceFile(), callee.text) !== undefined;
  if (child === callee) return ours;
  if (!call.arguments.some((argument) => argument === child)) return false;
  return ours || isModelCall(call) || calleeName(call) === 'defineProfile';
}

/** Whether `node` is part of the value `value` writes out, not something a function or a call inside it reads. */
function isWrittenIn(project: ProjectSource, node: ts.Node, value: ts.Expression): boolean {
  let child = node;
  for (let at = node.parent; at !== value.parent; child = at, at = at.parent) {
    if (ts.isCallExpression(at)) {
      if (!passes(project, at, child)) return false;
      continue;
    }
    const data = ts.isObjectLiteralExpression(at) || ts.isArrayLiteralExpression(at) ||
      ts.isPropertyAssignment(at) || ts.isShorthandPropertyAssignment(at) || ts.isSpreadAssignment(at) ||
      ts.isSpreadElement(at) || ts.isPropertyAccessExpression(at) || ts.isParenthesizedExpression(at) ||
      ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isNonNullExpression(at);
    if (!data) return false;
  }
  return true;
}

/** Whether `at` is written inside a call's options. */
export function isInTarget(target: SourceTarget, at: Located): boolean {
  return target.source === at.source && target.options.pos <= at.node.pos && at.node.end <= target.options.end;
}

/** Whether `at` is written in the arguments of the call that makes `target`: the target's alone. */
export function isInCall(target: SourceTarget, at: Located): boolean {
  const { call } = target;
  return !!call && call.source === at.source && call.node.pos <= at.node.pos && at.node.end <= call.node.end;
}

/** Each profile or tool whose options write `at` out as a value. A read inside a handler is code. */
function targetsOf(project: ProjectSource, targets: Map<string, SourceTarget[]>, at: Located): string[] {
  const names: string[] = [];
  for (const [name, held] of targets) {
    if (held.some((target) => isInTarget(target, at) && isWrittenIn(project, at.node, target.options))) names.push(name);
  }
  return names;
}

const USERS = new WeakMap<ProjectSource, Map<ts.Expression, ConstantUsers>>();

/**
 * Follows a constant to everything it sets: a profile or tool that reads it, and through a
 * constant that reads it, whatever reads that one. The answer is the project's: do not change it.
 */
export function usersOf(project: ProjectSource, binding: Binding): ConstantUsers {
  const known = USERS.get(project) ?? new Map<ts.Expression, ConstantUsers>();
  USERS.set(project, known);
  const cached = known.get(binding.initializer);
  if (cached) return cached;
  const users: ConstantUsers = { profiles: new Set(), tools: new Set(), code: false };
  const seen = new Set<ts.Expression>();
  const follow = (each: Binding) => {
    if (seen.has(each.initializer)) return;
    seen.add(each.initializer);
    const reads = readsOf(project, each);
    // A function nothing here calls is there for code the studio does not read.
    if (each.returns && !reads.length) users.code = true;
    for (const read of reads) {
      const profiles = targetsOf(project, project.profiles, read);
      const tools = profiles.length ? [] : targetsOf(project, project.tools, read);
      const held = profiles.length || tools.length ? undefined : holderOf(read);
      const holder = held && isWrittenIn(project, read.node, held.initializer) ? held : undefined;
      for (const profile of profiles) users.profiles.add(profile);
      for (const tool of tools) users.tools.add(tool);
      if (holder) follow(holder);
      else if (!profiles.length && !tools.length) users.code = true;
    }
  };
  follow(binding);
  known.set(binding.initializer, users);
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
export function importOf(source: ts.SourceFile, name: string): { specifier: string; name: string } | undefined {
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
  const { node } = followed(project, { node: held.initializer, source: target.source, env: target.env });
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * The names a function gives the call it makes, one for each place the project calls the function.
 * None unless every one of those calls says the name: the studio does not write what it cannot name.
 */
function madeBy(project: ProjectSource, target: SourceTarget, key: string): Array<[string, SourceTarget]> {
  const maker = holderOf({ node: target.options, source: target.source });
  const fn = maker && functionOf(project, target.source, maker.name);
  if (!maker || !fn || fn.value !== maker.initializer) return [];
  const named: Array<[string, SourceTarget]> = [];
  for (const read of readsOf(project, maker)) {
    const call = read.node.parent;
    const value = ts.isCallExpression(call) && call.expression === read.node ? calledValue(project, call, read) : undefined;
    if (!value?.env || !ts.isCallExpression(call)) return [];
    const made: SourceTarget = { ...target, env: value.env, call: { node: call, source: read.source } };
    const name = textOf(project, made, key);
    if (name === undefined) return [];
    named.push([name, made]);
  }
  return named;
}

/** Reads the project from `entry`, the setup module. `read` returns a file's text, or undefined. */
export function readProjectSource(entry: string, root: string, read: ReadFile): ProjectSource {
  const project: ProjectSource = { root, entry: resolve(entry), files: new Map(), profiles: new Map(), tools: new Map() };
  const queue = [project.entry];
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
  const made: typeof calls = [];
  for (const { into, key, target } of calls) {
    const named = textOf(project, target, key);
    if (named !== undefined) into.set(named, [...(into.get(named) ?? []), target]);
    else made.push({ into, key, target });
  }
  // A function that makes the call names it by a parameter: each call of the function is one.
  for (const { into, key, target } of made) {
    for (const [named, each] of madeBy(project, target, key)) into.set(named, [...(into.get(named) ?? []), each]);
  }
  return project;
}
