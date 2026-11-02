import { TheoremError } from '../guardrails/error.ts';
import { optionsProblem, optionValues } from './registry/options.ts';
import { assertSystemPrompt } from './system-parts.ts';
import { checkHolds, checkProblem, type Line, splitWhen } from './tools/activity-label.ts';
import type { ProfileOptions, ProfileSystem, SystemPart, SystemPiece } from './types.ts';

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

function factsSchema(options: ProfileOptions) {
  const properties: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(options)) {
    properties[name] = { type: 'string', enum: optionValues(decl) };
  }
  return { type: 'object', properties };
}

function lineProblem(parts: readonly SystemPart[], schema: unknown): string | undefined {
  if (parts.length === 0) return 'It has no wording to send.'; // labels-exempt: developer contract error
  const line = headOf(parts);
  if (line.joined) return 'A prompt line can\'t start with "+"; every line that fits is sent.'; // labels-exempt: developer contract error
  if (line.when === 'unreadable') {
    return 'A line that opens with "when" needs an option and a colon, like "when path is web: …".'; // labels-exempt: developer contract error
  }
  for (const check of line.when) {
    if (check.path.includes('.')) return `"${check.path}" isn't one option.`; // labels-exempt: developer contract error
    if (check.expected === null) return 'An option has no null value, so "is null" never fits.'; // labels-exempt: developer contract error
    const problem = checkProblem(check, schema, 'this profile’s options');
    if (problem) return problem;
  }
  if (line.when.length > 0 && !line.text && parts.length === 1) {
    return 'It has no wording to send.'; // labels-exempt: developer contract error
  }
  return undefined;
}

/** What is wrong with a prompt's options and lines, or undefined. */
export function systemLinesProblem(
  prompt: ProfileSystem,
  code: ProfileOptions | undefined,
  person: ProfileOptions | undefined,
): string | undefined {
  const declared = optionsProblem(code, person);
  if (declared) return declared;
  const schema = factsSchema({ ...code, ...person });
  for (const [at, parts] of linesOf(prompt).entries()) {
    const problem = lineProblem(parts, schema);
    if (problem) return `Line ${at + 1}: ${problem}`;
  }
  return undefined;
}

function lineFits(line: Line, facts: Record<string, string>): boolean {
  if (line.when === 'unreadable') return false;
  return line.when.every((check) => checkHolds(check, facts));
}

/** A line that fit a turn: its number in the prompt as written, from 1, and its pieces. */
export type KeptSystemLine = { line: number; pieces: SystemPiece[] };

/**
 * Every line that fits. Whether plain text is shareable is settled on the prompt as written, so a
 * line dropped on this turn never changes the marks of one that stayed.
 */
export function pickSystemLines(
  prompt: ProfileSystem,
  facts: Record<string, string>,
  fill: (text: string) => string | undefined,
): KeptSystemLine[] {
  const lines = linesOf(prompt);
  const marked = lines.flat().some((part) => typeof part !== 'string');
  const kept: KeptSystemLine[] = [];
  for (const [at, parts] of lines.entries()) {
    const line = headOf(parts);
    if (!lineFits(line, facts)) continue;
    const texts = parts.map((part, partAt) => fill(partAt === 0 ? line.text : textOf(part)));
    // why: a part that prints an unset option has a hole, and half a line says something else.
    if (texts.includes(undefined)) continue;
    const pieces = parts.flatMap((part, partAt): SystemPiece[] => {
      const text = texts[partAt];
      return text ? [{ text, private: typeof part === 'string' ? !marked : true }] : [];
    });
    kept.push({ line: at + 1, pieces });
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

/** The first tool in `tools` with a path `options.path` does not list, as a sentence. */
export function toolPathProblem(
  options: ProfileOptions | undefined,
  tools: readonly { name: string; paths?: readonly string[] }[],
): string | undefined {
  const path = options?.path;
  if (!path) return undefined;
  const known = optionValues(path);
  for (const tool of tools) {
    const bad = tool.paths?.find((path) => path !== '*' && !known.includes(path));
    if (bad !== undefined) {
      return `Tool ${tool.name} lists path "${bad}", which is not one of ${known.join(', ')}.`; // labels-exempt: developer contract error
    }
  }
  return undefined;
}
