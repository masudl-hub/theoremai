import { TheoremError } from '../guardrails/error.ts';
import { assertSystemPrompt } from './system-parts.ts';
import { checkHolds, checkProblem, type Line, splitWhen } from './tools/activity-label.ts';
import type {
  ProfileConditions,
  ProfileSystem,
  SystemPart,
  SystemPiece,
  TurnRequest,
} from './types.ts';

const CONDITION_NAME = /^[A-Za-z_][\w-]*$/;
const CONDITION_VALUE = /^\S+$/;

function linesOf(prompt: ProfileSystem): (readonly SystemPart[])[] {
  if (typeof prompt === 'string') return [[prompt]];
  return prompt.map((line) => (typeof line === 'string' ? [line] : line));
}

function textOf(part: SystemPart): string {
  return typeof part === 'string' ? part : part.private;
}

function headOf(parts: readonly SystemPart[]): Line {
  return splitWhen(parts[0] === undefined ? '' : textOf(parts[0]));
}

function factsSchema(
  conditions: ProfileConditions | undefined,
  slots: Record<string, readonly string[]>,
) {
  const properties: Record<string, unknown> = {};
  for (const [name, values] of Object.entries({ ...conditions, ...slots })) {
    properties[name] = { type: 'string', enum: [...values] };
  }
  return { type: 'object', properties };
}

function conditionsProblem(
  conditions: ProfileConditions | undefined,
  slots: Record<string, readonly string[]>,
): string | undefined {
  for (const [name, values] of Object.entries(conditions ?? {})) {
    if (!CONDITION_NAME.test(name)) return `Condition "${name}" needs a plain name.`; // labels-exempt: developer contract error
    if (name === 'input' || name === 'output') return `Condition "${name}" is a reserved name.`; // labels-exempt: developer contract error
    if (Object.hasOwn(slots, name)) return `"${name}" is both a condition and a slot.`; // labels-exempt: developer contract error
    if (values.length === 0) return `Condition "${name}" lists no values.`; // labels-exempt: developer contract error
    const bad = values.find((value) => !CONDITION_VALUE.test(value) || value === 'null');
    if (bad !== undefined) return `Condition "${name}" can't take the value "${bad}".`; // labels-exempt: developer contract error
  }
  return undefined;
}

function lineProblem(parts: readonly SystemPart[], schema: unknown): string | undefined {
  if (parts.length === 0) return 'It has no wording to send.'; // labels-exempt: developer contract error
  const line = headOf(parts);
  if (line.joined) return 'A prompt line can\'t start with "+"; every line that fits is sent.'; // labels-exempt: developer contract error
  if (line.when === 'unreadable') {
    return 'A line that opens with "when" needs a condition and a colon, like "when path is web: …".'; // labels-exempt: developer contract error
  }
  for (const check of line.when) {
    if (check.path.includes('.')) return `"${check.path}" isn't one condition or slot.`; // labels-exempt: developer contract error
    if (check.expected === null) return 'A condition always has a value, so "is null" never fits.'; // labels-exempt: developer contract error
    const problem = checkProblem(check, schema, 'this profile’s conditions or slots');
    if (problem) return problem;
  }
  if (line.when.length > 0 && !line.text && parts.length === 1) {
    return 'It has no wording to send.'; // labels-exempt: developer contract error
  }
  return undefined;
}

/** What is wrong with a prompt's conditions and lines, or undefined. */
export function systemLinesProblem(
  prompt: ProfileSystem,
  conditions: ProfileConditions | undefined,
  slots: Record<string, readonly string[]>,
): string | undefined {
  const declared = conditionsProblem(conditions, slots);
  if (declared) return declared;
  const schema = factsSchema(conditions, slots);
  for (const [at, parts] of linesOf(prompt).entries()) {
    const problem = lineProblem(parts, schema);
    if (problem) return `Line ${at + 1}: ${problem}`;
  }
  return undefined;
}

/** The facts a turn's `when` reads, once the turn has stated every condition with a listed value. */
export function turnFacts(
  id: string,
  conditions: ProfileConditions | undefined,
  req: Pick<TurnRequest, 'path' | 'conditions'>,
  slots: Record<string, string> | undefined,
): Record<string, string> {
  const stated = req.conditions ?? {};
  if (conditions === undefined) {
    if (req.conditions) throw new TheoremError('request', `Profile ${id} declares no conditions`); // labels-exempt: developer contract error
    return { ...slots };
  }
  if (Object.hasOwn(stated, 'path')) {
    throw new TheoremError('request', `Profile ${id}: the turn's own path states path`); // labels-exempt: developer contract error
  }
  for (const name of Object.keys(stated)) {
    if (!Object.hasOwn(conditions, name)) {
      throw new TheoremError('request', `Profile ${id} has no condition '${name}'`); // labels-exempt: developer contract error
    }
  }
  const facts: Record<string, string> = { ...slots };
  for (const [name, values] of Object.entries(conditions)) {
    const value = name === 'path' ? req.path : stated[name];
    if (value === undefined) {
      throw new TheoremError('request', `Profile ${id}: the turn left condition '${name}' unset`); // labels-exempt: developer contract error
    }
    if (!values.includes(value)) {
      throw new TheoremError(
        'request',
        `Profile ${id}: '${value}' is no value of condition '${name}'`, // labels-exempt: developer contract error
      );
    }
    facts[name] = value;
  }
  return facts;
}

function lineFits(line: Line, facts: Record<string, string>): boolean {
  if (line.when === 'unreadable') return false;
  for (const check of line.when) {
    if (!Object.hasOwn(facts, check.path)) {
      throw new TheoremError(
        'request',
        `A prompt line reads '${check.path}', and the turn stated no value for it`, // labels-exempt: developer contract error
      );
    }
  }
  return line.when.every((check) => checkHolds(check, facts));
}

/**
 * The pieces of every line that fits, one list per line. Whether plain text is shareable is settled
 * on the prompt as written, so a line dropped on this turn never changes the marks of one that stayed.
 */
export function pickSystemLines(
  prompt: ProfileSystem,
  facts: Record<string, string>,
  fill: (text: string) => string,
): SystemPiece[][] {
  const lines = linesOf(prompt);
  const marked = lines.flat().some((part) => typeof part !== 'string');
  const kept: SystemPiece[][] = [];
  for (const parts of lines) {
    const line = headOf(parts);
    if (!lineFits(line, facts)) continue;
    const pieces: SystemPiece[] = [];
    for (const [at, part] of parts.entries()) {
      const text = fill(at === 0 ? line.text : textOf(part));
      if (text) pieces.push({ text, private: typeof part === 'string' ? !marked : true });
    }
    kept.push(pieces);
  }
  return kept;
}

/** `where` names the prompt in the error. A bare `{ private }` must sit inside a line's own list. */
export function assertSystemLines(prompt: unknown, where: string): asserts prompt is ProfileSystem {
  if (typeof prompt === 'string') return;
  if (!Array.isArray(prompt)) {
    throw new TheoremError('config', `${where} must be a string or an array of lines`); // labels-exempt: developer contract error
  }
  if (prompt.length === 0) throw new TheoremError('config', `${where} must not be an empty array`); // labels-exempt: developer contract error
  for (const [at, line] of prompt.entries()) {
    if (typeof line === 'string') continue;
    if (!Array.isArray(line)) {
      throw new TheoremError(
        'config',
        `${where}[${at}] must be a string or a list of parts; put { private } inside the list`, // labels-exempt: developer contract error
      );
    }
    assertSystemPrompt(line, `${where}[${at}]`);
  }
}

/** The first tool in `tools` with a path `conditions.path` does not list, as a sentence. */
export function toolPathProblem(
  conditions: ProfileConditions | undefined,
  tools: readonly { name: string; paths?: readonly string[] }[],
): string | undefined {
  const known = conditions?.path;
  if (!known) return undefined;
  for (const tool of tools) {
    const bad = tool.paths?.find((path) => path !== '*' && !known.includes(path));
    if (bad !== undefined) {
      return `Tool ${tool.name} lists path "${bad}", which is not one of ${known.join(', ')}.`; // labels-exempt: developer contract error
    }
  }
  return undefined;
}
