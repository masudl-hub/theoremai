import { assertEquals } from '@std/assert';
import ts from 'typescript';
import { profileKeysOf } from '../../src/kernel/profile-scope.ts';
import { EXTRA_FIELDS, type FieldMeta, PROFILE_FIELDS } from '../../src/kernel/schema.ts';

const root = new URL('../../', import.meta.url).pathname;
const program = ts.createProgram([`${root}src/kernel/mod.ts`], {
  noEmit: true,
  strict: true,
  allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  types: [],
});
const checker = program.getTypeChecker();

function exported(file: string, name: string) {
  const module = checker.getSymbolAtLocation(program.getSourceFile(`${root}${file}`) as ts.Node);
  const symbol = checker.getExportsOfModule(module as ts.Symbol).find((each) => each.name === name);
  return symbol as ts.Symbol;
}

const KIND_FLAGS: Readonly<Record<string, ts.TypeFlags>> = {
  string: ts.TypeFlags.StringLike,
  ModelId: ts.TypeFlags.StringLike,
  ProfileId: ts.TypeFlags.StringLike,
  ToolId: ts.TypeFlags.StringLike,
  KeySlot: ts.TypeFlags.StringLike,
  number: ts.TypeFlags.NumberLike,
  boolean: ts.TypeFlags.BooleanLike,
};

/** What the type lets a builder write that the catalog check would refuse. */
function refusedByCatalog(type: ts.Type, fields: Record<string, FieldMeta>) {
  const sections = new Map<string, Set<string>>();
  for (const path of Object.keys(fields)) {
    const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
    sections.set(parent, (sections.get(parent) ?? new Set()).add(path.split('.').at(-1) as string));
  }
  const refused = new Set<string>();
  const seen = new Set<string>();
  const walk = (at: ts.Type, path: string) => {
    const members = (at.isUnion() ? at.types : [at]).filter(
      (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    const meta = fields[path];
    const flag = KIND_FLAGS[meta?.type ?? ''];
    for (const member of members) {
      if (flag && !(member.flags & flag))
        refused.add(`${path} takes ${checker.typeToString(member)}`);
      if (member.isStringLiteral() && meta?.options && !meta.options.includes(member.value)) {
        refused.add(`${path} takes '${member.value}'`);
      }
      if (!(member.flags & ts.TypeFlags.Object) && !member.isIntersection()) continue;
      const keys = sections.get(path);
      const walked = `${path}|${checker.typeToString(member)}`;
      if (!keys || keys.has('*') || path.startsWith('guardrails.detect') || seen.has(walked))
        continue;
      if (checker.isArrayType(member) || member.getCallSignatures().length) continue;
      seen.add(walked);
      for (const property of member.getProperties()) {
        const named = path ? `${path}.${property.name}` : property.name;
        if (!keys.has(property.name)) refused.add(named);
        else walk(checker.getNonNullableType(checker.getTypeOfSymbol(property)), named);
      }
    }
  };
  walk(type, '');
  return [...refused].sort();
}

Deno.test('the catalog holds every setting the profile types take', () => {
  const fields = Object.fromEntries(
    Object.entries(PROFILE_FIELDS).map(([path, meta]) => [profileKeysOf(path).join('.'), meta]),
  );
  const definition = exported('src/kernel/registry/profiles.ts', 'ProfileDefinition');
  assertEquals(refusedByCatalog(checker.getDeclaredTypeOfSymbol(definition), fields), []);
});

Deno.test('the catalog holds every setting the tool types take', () => {
  const fields = Object.fromEntries(
    Object.entries(EXTRA_FIELDS)
      .filter(([path]) => path.startsWith('registerTool.'))
      .map(([path, meta]) => [path.slice('registerTool.'.length), meta]),
  );
  const input = exported('src/kernel/tools/types.ts', 'ToolDefinitionInput');
  assertEquals(refusedByCatalog(checker.getDeclaredTypeOfSymbol(input), fields), []);
});
