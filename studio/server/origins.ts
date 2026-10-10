/**
 * Which of a project's settings its files set in code. The studio shows those
 * and does not change them, and says where each one is. It reads the same way
 * Save plans a change (`save-plan.ts`), so what a row says is what Save would do.
 *
 * @module
 */

import ts from 'typescript';
import {
  followed,
  holderOf,
  isInCall,
  isInTarget,
  type Located,
  type ObjectShape,
  type ProjectSource,
  propertyName,
  questionsExport,
  shapeOf,
  type SourceTarget,
  unwrapped,
  usersOf,
} from './project-source.ts';
import { NOT_PLAIN, plain } from './save-plan.ts';
import type { ProjectOrigins, SettingOrigin, SettingSite } from './save-wire.ts';

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

/** A setting, and the one place in the files that writes its value. */
interface Written {
  path: string[];
  at: Place;
  /** The constant or function that holds the place, when one does. */
  name?: string;
}

class Reader {
  readonly found: SettingOrigin[] = [];
  /** Where each value the walk followed a name to is written, the whole target first. */
  readonly written: Written[] = [];

  constructor(
    private readonly project: ProjectSource,
    private readonly kind: 'profile' | 'tool',
    private readonly target: SourceTarget,
  ) {}

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

  /** The whole target. */
  read() {
    const { options, source, env } = this.target;
    this.written.push({ path: [], at: { node: options, source } });
    this.walk({ node: options, source, env }, []);
  }

  /** What holds `at`: the target's own options, a constant or a function, or nothing the studio follows. */
  private regionOf(at: Located): ts.Node | undefined {
    if (isInTarget(this.target, at)) return this.target.options;
    return isInCall(this.target, at) ? this.target.call?.node : holderOf(at)?.initializer;
  }

  private walk(at: Located, path: string[]) {
    const node = unwrapped(at.node);
    if (plain(node) !== NOT_PLAIN) return;
    const here = { ...at, node };
    const shape = shapeOf(this.project, here);
    if (shape) {
      this.object(shape, here, path);
      return;
    }
    const whole = ts.isArrayLiteralExpression(node) &&
      !node.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element));
    if (whole) {
      node.elements.forEach((element, index) => this.walk({ ...at, node: element }, [...path, String(index)]));
      return;
    }
    this.named(here, path);
  }

  /** A value the files reach by a name, a call or a key: read where it is written. */
  private named(at: Located, path: string[]) {
    const origin = followed(this.project, at);
    if (origin.node === at.node && origin.source === at.source) this.note('code', path, at);
    else this.enter(origin, path, at);
  }

  /**
   * A value written somewhere other than where the walk is. In the target's own call it is the
   * target's. In a constant or a function it is read there, unless other code reads that too.
   */
  private enter(origin: Located, path: string[], from: Place) {
    if (isInTarget(this.target, origin) || isInCall(this.target, origin)) {
      this.written.push({ path, at: origin });
      this.walk(origin, path);
      return;
    }
    const holder = holderOf(origin);
    if (!holder) this.note('code', path, from);
    else if (usersOf(this.project, holder).code) {
      this.note('constant', path, { node: holder.initializer.parent, source: holder.source }, { text: holder.name });
    } else {
      this.written.push({ path, at: origin, name: holder.name });
      this.walk(origin, path);
    }
  }

  private object(shape: ObjectShape, at: Located, path: string[]) {
    const { open } = shape;
    const region = this.regionOf(at);
    // The last one of a name is the one that counts.
    for (const entry of [...shape.entries.values()].reverse()) {
      const schema = this.kind === 'tool' && path.length === 0 ? TOOL_SCHEMAS[entry.key] : undefined;
      const here = [...path, schema ?? entry.key];
      const place = entry.property ? { node: entry.property, source: entry.source } : at;
      if (schema) this.note('code', here, place);
      // A spread, or a key the file computes: what the object holds past it is not written here.
      else if (open && !open.after.has(entry.key)) this.note('code', here, open);
      else if (!entry.value) this.note('code', here, place);
      else if (entry.property && ts.isShorthandPropertyAssignment(entry.property)) this.named(entry.value, here);
      else if (this.regionOf(entry.value) === region) this.walk(entry.value, here);
      else this.enter(entry.value, here, place);
    }
    if (open) this.note('spread', path, open, { written: [...open.after] });
  }
}

interface Read {
  origins: SettingOrigin[];
  written: Written[];
}

function originsOf(project: ProjectSource, kind: 'profile' | 'tool', targets: readonly SourceTarget[]): Read {
  const [target] = targets;
  if (!target) return { origins: [], written: [] };
  if (targets.length > 1) {
    // Written twice: the studio cannot tell which one runs.
    const twice: SettingOrigin = { path: [], kind: 'twice', file: target.file, line: lineOf(target.options, target.source) };
    return { origins: [twice], written: [] };
  }
  const reader = new Reader(project, kind, target);
  reader.read();
  return { origins: reader.found, written: reader.written };
}

/**
 * Where a decision profile's questions are set: the setup module's `questions` export, at the
 * profile's own key when it writes one. A profile does not hold its questions, so the studio
 * shows them and does not change them. No place when the setup exports them another way.
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
  const places = new Map<ts.Node, { site: number; held: number }>();
  const read = (kind: 'profile' | 'tool', targets: Map<string, SourceTarget[]>) => {
    const origins: Record<string, SettingOrigin[]> = {};
    const written: Record<string, Written[]> = {};
    for (const [name, held] of targets) {
      const found = originsOf(project, kind, held);
      if (found.origins.length) origins[name] = found.origins;
      written[name] = found.written;
      for (const { at } of found.written) {
        const place = places.get(at.node) ?? { site: places.size + 1, held: 0 };
        places.set(at.node, { ...place, held: place.held + 1 });
      }
    }
    return { origins, written };
  };
  const [profiles, tools] = [read('profile', project.profiles), read('tool', project.tools)];
  for (const id of decisions) profiles.origins[id] = [...(profiles.origins[id] ?? []), questionsOrigin(project, id)];
  /** The places more than one setting reads, and under each of them the ones a setting has to itself. */
  const sites = (written: Record<string, Written[]>) => {
    const sites: Record<string, SettingSite[]> = {};
    for (const [name, held] of Object.entries(written)) {
      const shared = held.filter(({ at }) => (places.get(at.node)?.held ?? 0) > 1);
      const under = (path: string[]) => shared.some((each) => each.path.every((key, index) => path[index] === key));
      const kept = held.filter((each) => shared.includes(each) || under(each.path));
      if (!shared.length) continue;
      sites[name] = kept.map(({ path, at, name: holder }): SettingSite => ({
        path,
        site: places.get(at.node)?.site ?? 0,
        shared: shared.some((each) => each.at.node === at.node),
        ...(holder ? { name: holder } : {}),
        file: at.source.fileName,
        line: lineOf(at.node, at.source),
      }));
    }
    return sites;
  };
  const held = { profiles: sites(profiles.written), tools: sites(tools.written) };
  const some = Object.keys(held.profiles).length + Object.keys(held.tools).length > 0;
  return { profiles: profiles.origins, tools: tools.origins, ...(some ? { sites: held } : {}) };
}
