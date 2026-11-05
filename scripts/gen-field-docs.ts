/**
 * Writes `src/kernel/field-docs.ts`: `FIELD_DOCS`, the doc of every catalog field a type declares,
 * and `EXPORT_DOCS`, the doc of every export `API_EXPORTS` names. Each is the JSDoc description on
 * the declaration.
 *
 * A field is found by walking its path through the type of its section. A `@catalog <path>` tag
 * on any declaration claims that path too: for a field whose name differs from its path, or for
 * the entries of a map (`models.*`), whose doc goes on the map's property. Text after the path is
 * that path's own doc; with none, the description is.
 *
 * It also writes `OPTION_DOCS`: the JSDoc on each value of an `as const` list, keyed by the list's
 * name, for the catalog rows whose options that list gives. A list that documents one value must
 * document every value; a spread list brings its own values' docs. A table elsewhere that gives
 * those values a `doc` of its own is a problem: it reads `OPTION_DOCS` instead.
 *
 *   deno task field-docs
 *
 * @module
 */

import ts from 'typescript';
import { API_EXPORTS, REQUEST_FIELDS } from '../src/kernel/api-catalog.ts';
import { profileKeysOf } from '../src/kernel/profile-scope.ts';
import { EXTRA_FIELDS, PROFILE_FIELDS } from '../src/kernel/schema.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const OUT = new URL('../src/kernel/field-docs.ts', import.meta.url);

type Catalog = 'profile' | 'extra' | 'request';

/** The catalog sections types declare: the path prefix and the types it walks. */
const SECTIONS = [
  {
    catalog: 'profile',
    prefix: '',
    file: 'src/kernel/registry/profiles.ts',
    types: ['ProfileDefinition'],
  },
  {
    catalog: 'extra',
    prefix: 'registerTool.',
    file: 'src/kernel/tools/types.ts',
    // What `registerTool` takes, and what it registers: the JSON Schemas it makes of `input` and `output`.
    types: ['ToolDefinitionInput', 'RegisteredTool'],
  },
  {
    catalog: 'extra',
    prefix: 'registerStructured.',
    file: 'src/kernel/types.ts',
    types: ['StructuredSpec'],
  },
  {
    catalog: 'extra',
    prefix: 'done.stop.',
    file: 'src/kernel/turn-events.ts',
    types: ['TurnStop'],
  },
  { catalog: 'extra', prefix: 'decision.', file: 'studio/draft.ts', types: ['DecisionDraft'] },
  { catalog: 'request', prefix: 'runTurn.', file: 'src/kernel/types.ts', types: ['TurnRequest'] },
] as const satisfies readonly {
  catalog: Catalog;
  prefix: string;
  file: string;
  types: readonly string[];
}[];

type Section = (typeof SECTIONS)[number];

/** Every TypeScript file of the repo's own source, so the walk reaches what no entry imports. */
function sourceFiles(): string[] {
  const listed = new Deno.Command('git', {
    args: ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', 'src', 'studio'],
    stdout: 'piped',
  }).outputSync();
  return new TextDecoder()
    .decode(listed.stdout)
    .split('\n')
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => `${ROOT}${file}`)
    .filter(isOwnPath);
}

function program(): ts.Program {
  return ts.createProgram([`${ROOT}mod.ts`, ...sourceFiles()], {
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  });
}

/** Every catalog row: the catalog it is in and its path. */
function catalogRows(): { catalog: Catalog; path: string }[] {
  const rows = (catalog: Catalog, fields: object) =>
    Object.keys(fields).map((path) => ({ catalog, path }));
  return [
    ...rows('profile', PROFILE_FIELDS),
    ...rows('extra', EXTRA_FIELDS),
    ...rows('request', REQUEST_FIELDS),
  ];
}

/** A row's section and the keys it walks inside the section's type, or none. */
function sectionOf(
  catalog: Catalog,
  path: string,
): { section: Section; keys: string[] } | undefined {
  const section = SECTIONS.filter(
    (each) => each.catalog === catalog && path.startsWith(each.prefix),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!section) return undefined;
  const keys = section.prefix ? path.slice(section.prefix.length).split('.') : profileKeysOf(path);
  return { section, keys };
}

/** The property declarations in the repo's source that a key path reaches. */
function declarationsAt(
  checker: ts.TypeChecker,
  root: ts.Type,
  keys: readonly string[],
): ts.Declaration[] {
  let types = [root];
  let found: ts.Declaration[] = [];
  for (const key of keys) {
    const next: ts.Type[] = [];
    found = [];
    for (const type of types.flatMap((each) => objectMembers(checker, each, key !== '*'))) {
      if (key === '*') {
        const element = checker.isArrayType(type)
          ? checker.getTypeArguments(type as ts.TypeReference)[0]
          : checker.getIndexInfosOfType(type)[0]?.type;
        if (element) next.push(checker.getNonNullableType(element));
        continue;
      }
      const property = type.getProperty(key);
      if (!property) continue;
      next.push(checker.getNonNullableType(checker.getTypeOfSymbol(property)));
      found.push(...(property.declarations ?? []).filter(isOwnProperty));
    }
    types = next;
  }
  return [...new Set(found)];
}

function objectMembers(checker: ts.TypeChecker, type: ts.Type, unwrapArrays: boolean): ts.Type[] {
  const members = type.isUnion() ? type.types : [type];
  return members.flatMap((member) => {
    if (!(member.flags & ts.TypeFlags.Object) && !member.isIntersection()) return [];
    if (unwrapArrays && checker.isArrayType(member)) {
      const element = checker.getTypeArguments(member as ts.TypeReference)[0];
      return element ? objectMembers(checker, element, true) : [];
    }
    return [member];
  });
}

function isOwnFile(file: ts.SourceFile): boolean {
  return isOwnPath(file.fileName);
}

function isOwnPath(name: string): boolean {
  return (
    (name.startsWith(`${ROOT}src/`) || name.startsWith(`${ROOT}studio/`)) &&
    !name.includes('/node_modules/') &&
    !name.startsWith(`${ROOT}studio/npm/`)
  );
}

function isOwnProperty(declaration: ts.Declaration): boolean {
  return (
    isOwnFile(declaration.getSourceFile()) &&
    (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration))
  );
}

/** The JSDoc on a declaration: its description, and the paths its `@catalog` tags claim. */
function jsDocOf(declaration: ts.Node): {
  description: string;
  paths: Record<string, string>;
} {
  const doc = ts.getJSDocCommentsAndTags(declaration).filter(ts.isJSDoc).at(-1);
  const paths: Record<string, string> = {};
  for (const tag of doc?.tags ?? []) {
    if (tag.tagName.text !== 'catalog') continue;
    const [path, ...text] = flat(ts.getTextOfJSDocComment(tag.comment)).split(' ');
    paths[path] = text.join(' ');
  }
  return { description: flat(ts.getTextOfJSDocComment(doc?.comment)), paths };
}

function flat(text: string | undefined): string {
  return (text ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function where(declaration: ts.Node): string {
  const file = declaration.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(declaration.getStart());
  return `${file.fileName.slice(ROOT.length)}:${line + 1}`;
}

/** Every declaration in the repo's source that a `@catalog` tag gives a path, by path. */
function claims(built: ts.Program): Map<string, ts.Node[]> {
  const found = new Map<string, ts.Node[]>();
  const visit = (node: ts.Node) => {
    for (const path of Object.keys(jsDocOf(node).paths)) {
      found.set(path, [...(found.get(path) ?? []), node]);
    }
    ts.forEachChild(node, visit);
  };
  for (const file of built.getSourceFiles()) if (isOwnFile(file)) visit(file);
  return found;
}

function exportedTypes(checker: ts.TypeChecker, built: ts.Program, section: Section): ts.Type[] {
  const file = built.getSourceFile(`${ROOT}${section.file}`) as ts.SourceFile;
  const module = checker.getSymbolAtLocation(file) as ts.Symbol;
  const exports = checker.getExportsOfModule(module);
  return section.types.map((name) =>
    checker.getDeclaredTypeOfSymbol(exports.find((each) => each.name === name) as ts.Symbol),
  );
}

/** One text from a set of declarations, or why there is none. */
function oneText(
  label: string,
  texts: Map<string, string>,
): { text: string } | { problem: string } {
  const distinct = [...new Set(texts.values())];
  const at = [...texts.keys()].join(', ');
  if (distinct.length > 1)
    return { problem: `${label}: its declarations say different things: ${at}` };
  if (!distinct[0]) return { problem: `${label}: no JSDoc at ${at}` };
  return { text: distinct[0] };
}

/** The JSDoc of each export `API_EXPORTS` names, read from the package's root module. */
function exportDocs(
  checker: ts.TypeChecker,
  built: ts.Program,
  problems: string[],
): Record<string, string> {
  const module = checker.getSymbolAtLocation(
    built.getSourceFile(`${ROOT}mod.ts`) as ts.SourceFile,
  ) as ts.Symbol;
  const exports = new Map(checker.getExportsOfModule(module).map((each) => [each.name, each]));
  const docs: Record<string, string> = {};
  for (const name of Object.keys(API_EXPORTS)) {
    const symbol = exports.get(name);
    if (!symbol) {
      problems.push(`${name}: the root module does not export it`);
      continue;
    }
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    // An overloaded function's doc is its first signature's.
    const declaration = (target.declarations ?? []).find(
      (each) => ts.isFunctionDeclaration(each) || ts.isClassDeclaration(each),
    );
    const result = declaration
      ? oneText(name, new Map([[where(declaration), jsDocOf(declaration).description]]))
      : { problem: `${name}: no function or class declares it` };
    if ('problem' in result) problems.push(result.problem);
    else docs[name] = result.text;
  }
  return docs;
}

/** The description in a `/** … *\/` comment: its text before the first tag. */
function commentDescription(comment: string): string {
  const lines = comment
    .slice(3, -2)
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''));
  const tag = lines.findIndex((line) => line.startsWith('@'));
  return flat((tag === -1 ? lines : lines.slice(0, tag)).join('\n'));
}

/** The description of the JSDoc comment right before a list value, if it has one. */
function valueDoc(value: ts.Expression): string {
  const text = value.getSourceFile().text;
  const comment = (ts.getLeadingCommentRanges(text, value.pos) ?? [])
    .filter((range) => text.startsWith('/**', range.pos))
    .at(-1);
  return comment ? commentDescription(text.slice(comment.pos, comment.end)) : '';
}

/** The values of every `as const` list in the repo's source, by the list's name. */
function constLists(built: ts.Program): Map<string, ts.VariableDeclaration[]> {
  const found = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isSatisfiesExpression(init)) init = init.expression;
      if (
        ts.isAsExpression(init) &&
        ts.isArrayLiteralExpression(init.expression) &&
        init.type.getText() === 'const'
      ) {
        found.set(node.name.text, [...(found.get(node.name.text) ?? []), node]);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of built.getSourceFiles()) if (isOwnFile(file)) visit(file);
  return found;
}

function listValues(declaration: ts.VariableDeclaration): readonly ts.Expression[] {
  let init = declaration.initializer as ts.Expression;
  while (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)) init = init.expression;
  return (init as ts.ArrayLiteralExpression).elements;
}

/** The doc of each value of every list that documents its values, by the list's name. */
function optionDocs(built: ts.Program, problems: string[]): Record<string, Record<string, string>> {
  const lists = constLists(built);
  const memo = new Map<string, Record<string, string> | undefined>();
  const docsOf = (name: string): Record<string, string> | undefined => {
    if (memo.has(name)) return memo.get(name);
    memo.set(name, undefined);
    const declarations = lists.get(name) ?? [];
    if (declarations.length !== 1) return undefined;
    const docs: Record<string, string> = {};
    const missing: string[] = [];
    let documented = false;
    for (const value of listValues(declarations[0])) {
      if (ts.isSpreadElement(value) && ts.isIdentifier(value.expression)) {
        const spread = docsOf(value.expression.text);
        if (spread) {
          Object.assign(docs, spread);
          documented = true;
        } else missing.push(where(value));
        continue;
      }
      if (!ts.isStringLiteral(value)) return undefined;
      const doc = valueDoc(value);
      if (doc) documented = true;
      else missing.push(`${value.text} at ${where(value)}`);
      docs[value.text] = doc;
    }
    if (!documented) return undefined;
    if (missing.length) {
      problems.push(`${name}: it documents some values but not ${missing.join(', ')}`);
      return undefined;
    }
    memo.set(name, docs);
    return docs;
  };
  const docs: Record<string, Record<string, string>> = {};
  for (const name of lists.keys()) {
    const found = docsOf(name);
    if (!found) continue;
    if ((lists.get(name) ?? []).length !== 1) {
      problems.push(`${name}: more than one list has this name`);
      continue;
    }
    docs[name] = found;
  }
  return docs;
}

/** The lists a type annotation names through aliases such as `type X = (typeof LIST)[number]`. */
function listsNamed(checker: ts.TypeChecker, annotation: ts.TypeNode | undefined): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isTypeReferenceNode(node)) {
      let symbol = checker.getSymbolAtLocation(node.typeName);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      let type = symbol?.declarations?.find(ts.isTypeAliasDeclaration)?.type;
      if (type && ts.isIndexedAccessTypeNode(type)) {
        type = type.objectType;
        while (ts.isParenthesizedTypeNode(type)) type = type.type;
        if (ts.isTypeQueryNode(type)) names.add(type.exprName.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  if (annotation) visit(annotation);
  return names;
}

/**
 * Each table in the repo's source that gives a documented list's values a `doc` of its own: one
 * whose declared type names the list, or whose keys are the list's values.
 */
function restated(
  checker: ts.TypeChecker,
  built: ts.Program,
  options: Record<string, Record<string, string>>,
  problems: string[],
): void {
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = node.properties
        .filter(
          (each): each is ts.PropertyAssignment =>
            ts.isPropertyAssignment(each) &&
            ts.isObjectLiteralExpression(each.initializer) &&
            each.initializer.properties.some(
              (inner) => inner.name !== undefined && inner.name.getText() === 'doc',
            ),
        )
        .map((each) => (ts.isStringLiteral(each.name) ? each.name.text : each.name.getText()));
      const declared = ts.isVariableDeclaration(node.parent)
        ? listsNamed(checker, node.parent.type)
        : new Set<string>();
      for (const [name, docs] of Object.entries(options)) {
        const values = Object.keys(docs);
        if (!values.every((value) => keys.includes(value))) continue;
        if (declared.has(name) || keys.length === values.length) {
          problems.push(
            `${where(node)}: it gives ${name}'s values a doc; read OPTION_DOCS.${name}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of built.getSourceFiles()) if (isOwnFile(file)) visit(file);
}

/** The doc of each catalog path a declaration gives, each export's doc, and why any has none. */
export function fieldDocs(): {
  docs: Record<string, string>;
  exports: Record<string, string>;
  options: Record<string, Record<string, string>>;
  problems: string[];
} {
  const built = program();
  const checker = built.getTypeChecker();
  const roots = new Map(
    SECTIONS.map((section) => [section, exportedTypes(checker, built, section)]),
  );
  const claimed = claims(built);
  const rows = catalogRows();
  const docs: Record<string, string> = {};
  const problems: string[] = [];
  for (const { catalog, path } of rows) {
    const walk = sectionOf(catalog, path);
    const walked = walk
      ? (roots.get(walk.section) ?? []).flatMap((root) => declarationsAt(checker, root, walk.keys))
      : [];
    const declarations = [...new Set<ts.Node>([...walked, ...(claimed.get(path) ?? [])])];
    if (!declarations.length) continue;
    const result = oneText(
      path,
      new Map(
        declarations.map((each) => {
          const { description, paths } = jsDocOf(each);
          return [where(each), paths[path] || description] as const;
        }),
      ),
    );
    if ('problem' in result) problems.push(result.problem);
    else docs[path] = result.text;
  }
  const paths = new Set(rows.map((row) => row.path));
  for (const [path, nodes] of claimed) {
    if (!paths.has(path)) {
      problems.push(
        `${path}: a @catalog tag names it, but no catalog has it: ${nodes.map(where).join(', ')}`,
      );
    }
  }
  const options = optionDocs(built, problems);
  restated(checker, built, options, problems);
  return { docs, exports: exportDocs(checker, built, problems), options, problems };
}

function rowsOf(docs: Record<string, string>): string {
  return Object.keys(docs)
    .sort()
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(docs[key])},`)
    .join('\n');
}

/** The text of `field-docs.ts` for these docs. */
export function fieldDocsModule(
  docs: Record<string, string>,
  exports: Record<string, string>,
  options: Record<string, Record<string, string>>,
): string {
  const lists = Object.keys(options).sort();
  return `/** labels-exempt-file: authoring field-meta docs — not runtime user or model copy (P2) */
/**
 * Generated by \`scripts/gen-field-docs.ts\` from the JSDoc on the declarations.
 * Do not edit: change the JSDoc and run the script.
 *
 * @module
 */

/** The doc of each catalog field a type declares, keyed by catalog path. */
export const FIELD_DOCS: Readonly<Record<string, string>> = {
${rowsOf(docs)}
};

/** The doc of each export \`API_EXPORTS\` names, keyed by that name. */
export const EXPORT_DOCS: Readonly<Record<string, string>> = {
${rowsOf(exports)}
};

/** The doc of each value of an \`as const\` list, keyed by the list's name, then by the value. */
export const OPTION_DOCS: Readonly<
  Record<${lists.map((name) => JSON.stringify(name)).join(' | ')}, Readonly<Record<string, string>>>
> = {
${lists
  .map(
    (name) =>
      `  ${name}: {\n${Object.entries(options[name])
        .map(([value, doc]) => `    ${JSON.stringify(value)}: ${JSON.stringify(doc)},`)
        .join('\n')}\n  },`,
  )
  .join('\n')}
};
`;
}

if (import.meta.main) {
  const { docs, exports, options, problems } = fieldDocs();
  if (problems.length) {
    console.error(problems.join('\n'));
    Deno.exit(1);
  }
  await Deno.writeTextFile(OUT, fieldDocsModule(docs, exports, options));
  const fmt = new Deno.Command('npx', {
    args: ['biome', 'format', '--write', OUT.pathname],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (!(await fmt.output()).success) Deno.exit(1);
}
