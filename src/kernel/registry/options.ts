/**
 * Options: the named values a turn can hold. One on `identity.options` is the host's code to state
 * on `TurnRequest.options`; one on `inputs.options` is the person's to pick on
 * `TurnRequest.input.options`. Nothing else differs: either one chooses prompt lines with `when`
 * and prints with `{name}`, and either one can go unset.
 */
import { TheoremError } from '../../guardrails/error.ts';
import type { OptionDecl, Profile, ProfileOptions, TurnRequest } from '../types.ts';
import { profileInputs } from './catalog.ts';

const OPTION_NAME = /^[A-Za-z_][\w-]*$/;
const OPTION_REF = /\{([A-Za-z_][\w-]*)\}/g;
const RESERVED_NAMES: readonly string[] = ['input', 'output'];

/** The values one option can take. */
export function optionValues(decl: OptionDecl): string[] {
  return decl.choices.map((choice) => choice.value);
}

/** The options the host's code states. */
function codeOptions(profile: Profile): ProfileOptions {
  const takesOptions =
    profile.type === 'text' || profile.type === 'image' || profile.type === 'live';
  return (takesOptions ? profile.identity.options : undefined) ?? {};
}

/** The options a person picks. */
function personOptions(profile: Profile): ProfileOptions {
  return profileInputs(profile)?.options ?? {};
}

/** One option of the profile, whichever object holds it. */
export function profileOption(profile: Profile, name: string): OptionDecl | undefined {
  const declared = { ...codeOptions(profile), ...personOptions(profile) };
  return Object.hasOwn(declared, name) ? declared[name] : undefined;
}

function optionProblem(name: string, decl: OptionDecl): string | undefined {
  if (!OPTION_NAME.test(name)) return `Option "${name}" needs a plain name.`; // labels-exempt: developer contract error
  if (RESERVED_NAMES.includes(name)) return `Option "${name}" is a reserved name.`; // labels-exempt: developer contract error
  const values = Array.isArray(decl.choices) ? optionValues(decl) : [];
  if (values.length === 0) return `Option "${name}" lists no values.`; // labels-exempt: developer contract error
  const bad = values.find((value) => !value.trim() || value === 'null');
  return bad === undefined ? undefined : `Option "${name}" can't take the value "${bad}".`; // labels-exempt: developer contract error
}

/** What is wrong with a profile's options, or undefined. */
export function optionsProblem(
  code: ProfileOptions | undefined,
  person: ProfileOptions | undefined,
): string | undefined {
  for (const [name, decl] of Object.entries({ ...code, ...person })) {
    if (code && person && Object.hasOwn(code, name) && Object.hasOwn(person, name)) {
      return `"${name}" is on both identity.options and inputs.options.`; // labels-exempt: developer contract error
    }
    const problem = optionProblem(name, decl);
    if (problem) return problem;
  }
  return undefined;
}

function assertValues(
  id: string,
  declared: ProfileOptions,
  where: string,
  values: Readonly<Record<string, string>> | undefined,
): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    const decl = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (!decl)
      throw new TheoremError('request', `Profile ${id} has no option '${name}' on ${where}`); // labels-exempt: developer contract error
    const choices = optionValues(decl);
    if (!choices.includes(value)) {
      throw new TheoremError(
        'request',
        `Profile ${id}: option '${name}' takes ${choices.join(', ')}, not '${value}'`, // labels-exempt: developer contract error
      );
    }
  }
}

/** The turn's own path, as the `path` option holds it, if the profile declares one. */
function statedPath(code: ProfileOptions, req: Pick<TurnRequest, 'path'>): Record<string, string> {
  return Object.hasOwn(code, 'path') && req.path !== undefined ? { path: req.path } : {};
}

/** Refuses a value the profile doesn't list, and one sent through the other door. */
export function assertTurnOptions(profile: Profile, req: TurnRequest): void {
  const code = codeOptions(profile);
  if (req.options && Object.hasOwn(req.options, 'path')) {
    throw new TheoremError('request', `Profile ${profile.id}: the turn's own path states path`); // labels-exempt: developer contract error
  }
  assertValues(profile.id, code, 'identity.options', { ...req.options, ...statedPath(code, req) });
  assertValues(profile.id, personOptions(profile), 'inputs.options', req.input?.options);
}

/** The value of each option the turn set, from either door. */
export function turnFacts(profile: Profile, req: TurnRequest): Record<string, string> {
  return { ...req.options, ...statedPath(codeOptions(profile), req), ...req.input?.options };
}

/**
 * Prints each `{name}` that names one of the profile's options. A `{name}` that is no option stays
 * as written. Text that prints an option the turn left unset has a hole in it, so it gives
 * undefined and the caller sends none of it. Every value is one the profile lists, so no free text
 * is written.
 */
export function fillOptions(
  profile: Profile,
  text: string,
  facts: Readonly<Record<string, string>>,
): string | undefined {
  let isWhole = true;
  const filled = text.replace(OPTION_REF, (whole, name: string) => {
    if (!profileOption(profile, name)) return whole;
    const value = Object.hasOwn(facts, name) ? facts[name] : undefined;
    if (value === undefined) isWhole = false;
    return value ?? whole;
  });
  return isWhole ? filled : undefined;
}
