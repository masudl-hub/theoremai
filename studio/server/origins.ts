/**
 * Which of a project's settings its files set in code. The studio shows those
 * and does not change them, and says where each one is. It reads the same way
 * Save plans a change (`save-plan.ts`), so what a row says is what Save would do.
 *
 * @module
 */

import ts from 'typescript';
import {
  type Located,
  namedValue,
  type ProjectSource,
  propertyName,
  questionsExport,
  type SourceTarget,
  unwrapped,
  usersOf,
} from './project-source.ts';
import { NOT_PLAIN, plain } from './save-plan.ts';
import type { ProjectOrigins, SettingOrigin } from './save-wire.ts';

/** The most of an expression a row shows. */
const TEXT_LENGTH = 48;

/** An expression as the file writes it, on one line and cut to fit a row. */
function textOf(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source).replace(/\s+/g, ' ');
  return text.length > TEXT_LENGTH ? `${text.slice(0, TEXT_LENGTH - 1)}…` : text;
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** A tool's schemas are its `input` and `output` in the file, and Zod objects there. */
const TOOL_SCHEMAS: Record<string, string> = { input: 'inputSchema', output: 'outputSchema' };

/** Something a file writes, in that file. */
type Place = { node: ts.Node; source: ts.SourceFile };

class Reader {
  readonly found: SettingOrigin[] = [];

  constructor(private readonly project: ProjectSource, private readonly kind: 'profile' | 'tool') {}

  private note(kind: SettingOrigin['kind'], path: string[], at: Place, more: Pick<SettingOrigin, 'text' | 'written'> = {}) {
    this.found.push({
      path,
      kind,
      text: textOf(at.node, at.source),
      file: at.source.fileName,
      line: lineOf(at.node, at.source),
      ...more,
    });
  }

  walk(expression: ts.Expression, source: ts.SourceFile, path: string[]) {
    const node = unwrapped(expression);
    if (plain(node) !== NOT_PLAIN) return;
    if (ts.isObjectLiteralExpression(node)) {
      this.object(node, source, path);
      return;
    }
    const whole = ts.isArrayLiteralExpression(node) &&
      !node.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element));
    if (whole) {
      node.elements.forEach((element, index) => this.walk(element, source, [...path, String(index)]));
      return;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) this.named({ node, source }, path);
    else this.note('code', path, { node, source });
  }

  /** A value a name stands for: read where the constant is, unless other code reads the constant too. */
  private named(at: Located, path: string[]) {
    const { origin, holder } = namedValue(this.project, at);
    if (!holder) this.note('code', path, at);
    else if (usersOf(this.project, holder).code) {
      this.note('constant', path, { node: holder.initializer.parent, source: holder.source }, { text: holder.name });
    }
    else this.walk(origin.node, origin.source, path);
  }

  private object(node: ts.ObjectLiteralExpression, source: ts.SourceFile, path: string[]) {
    const properties = [...node.properties];
    /** A spread, or a key the file computes: what the object holds past it is not written here. */
    const isOpen = (property: ts.ObjectLiteralElementLike) => propertyName(property) === undefined;
    const lastOpen = properties.findLastIndex(isOpen);
    const written: string[] = [];
    const seen = new Set<string>();
    for (let index = properties.length - 1; index >= 0; index -= 1) {
      const property = properties[index] as ts.ObjectLiteralElementLike;
      const name = propertyName(property);
      // The last one of a name is the one that counts.
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      const schema = this.kind === 'tool' && path.length === 0 ? TOOL_SCHEMAS[name] : undefined;
      const here = [...path, schema ?? name];
      if (schema) this.note('code', here, { node: property, source });
      else if (index < lastOpen) this.note('code', here, { node: properties[lastOpen] as ts.Node, source });
      else if (ts.isShorthandPropertyAssignment(property)) this.named({ node: property.name, source }, here);
      else if (!ts.isPropertyAssignment(property)) this.note('code', here, { node: property, source });
      else this.walk(property.initializer, source, here);
      if (index > lastOpen) written.push(name);
    }
    if (lastOpen >= 0) {
      this.note('spread', path, { node: properties[lastOpen] as ts.Node, source }, { written: written.reverse() });
    }
  }
}

function originsOf(project: ProjectSource, kind: 'profile' | 'tool', targets: readonly SourceTarget[]): SettingOrigin[] {
  const [target] = targets;
  if (!target) return [];
  if (targets.length > 1) {
    // Written twice: the studio cannot tell which one runs.
    return [{ path: [], kind: 'twice', file: target.file, line: lineOf(target.options, target.source) }];
  }
  const reader = new Reader(project, kind);
  reader.walk(target.options, target.source, []);
  return reader.found;
}

/**
 * Where a decision profile's questions are set: the setup module's `questions` export, at the
 * profile's own key when it writes one. A profile does not hold its questions, so the studio
 * shows them and Save does not write them. No place when the setup exports them another way.
 */
function questionsOrigin(project: ProjectSource, profileId: string): SettingOrigin {
  const origin: SettingOrigin = { path: ['decision', 'questions'], kind: 'code', text: 'export const questions' };
  const source = project.files.get(project.entry);
  const held = source && questionsExport(source);
  if (!source || !held) return origin;
  const value = held.initializer && unwrapped(held.initializer);
  const own = value && ts.isObjectLiteralExpression(value)
    ? value.properties.findLast((property) => propertyName(property) === profileId)
    : undefined;
  return { ...origin, file: source.fileName, line: lineOf(own ?? held, source) };
}

/**
 * The settings the project's files set in code, for each profile and tool the files define. A
 * profile or tool with none is left out. `decisions` names the decision profiles the studio
 * shows: each one's questions are set in the setup module.
 */
export function sourceOrigins(project: ProjectSource, decisions: readonly string[] = []): ProjectOrigins {
  const read = (kind: 'profile' | 'tool', targets: Map<string, SourceTarget[]>) => {
    const origins: Record<string, SettingOrigin[]> = {};
    for (const [name, held] of targets) {
      const found = originsOf(project, kind, held);
      if (found.length) origins[name] = found;
    }
    return origins;
  };
  const profiles = read('profile', project.profiles);
  for (const id of decisions) profiles[id] = [...(profiles[id] ?? []), questionsOrigin(project, id)];
  return { profiles, tools: read('tool', project.tools) };
}
