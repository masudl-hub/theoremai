/**
 * What the studio command prints when a project opens: each thing the page would flag, one line
 * each, so a builder sees it without opening the page. `--quiet` turns it off.
 *
 * @module
 */

import type { StudioDescription } from './handler.ts';

/** How many of a difference's settings a line names before it says how many more. */
const NAMED_SETTINGS = 3;

function settingsList(settings: readonly string[]): string {
  const named = settings.slice(0, NAMED_SETTINGS).join(', ');
  const more = settings.length - NAMED_SETTINGS;
  return more > 0 ? `${named} and ${more} more` : named;
}

/** Each thing about the project the builder should look at, as a line for the terminal. */
export function alertLines(description: StudioDescription): string[] {
  const {
    problems,
    modelProblems = [],
    differences = [],
    unheld = [],
    unregistered = [],
    unloaded,
    peopleProblem,
  } = description;
  return [
    ...(unloaded === undefined
      ? []
      : [`The files stopped loading; the studio shows the last load that did:\n${unloaded}`]),
    ...unheld.map((message) => `The project does not compile as the studio opened it: ${message}`),
    ...problems.map(({ profile, message }) => `${profile}: ${message}`),
    ...modelProblems.map(({ profile, model, message }) => `${profile}, model ${model}: ${message}`),
    ...differences.map(
      ({ kind, of, settings }) =>
        `${kind} ${of} opens differently from what the project registered, in ${settings.length} ${settings.length === 1 ? 'setting' : 'settings'}: ${settingsList(settings)}`,
    ),
    ...unregistered.map(
      ({ kind, name, file, line }) =>
        `${kind} ${name} is defined at ${file}:${line} but the project did not register it`,
    ),
    ...(peopleProblem === undefined ? [] : [`people: ${peopleProblem}`]),
  ];
}

/** The lines as one message for the terminal, or undefined when there is nothing to look at. */
export function alertText(description: StudioDescription): string | undefined {
  const lines = alertLines(description);
  if (lines.length === 0) return undefined;
  const heading = `theorem studio: ${lines.length} ${lines.length === 1 ? 'thing' : 'things'} to look at in ${description.project}`;
  return [heading, ...lines.map((line) => `  - ${line.replaceAll('\n', '\n    ')}`)].join('\n');
}
