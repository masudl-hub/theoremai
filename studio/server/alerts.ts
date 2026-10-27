/**
 * What the studio command prints when a project opens: what it loaded and from where, each thing
 * the page would flag, one line each, and what each provider said of its key, so a builder sees it
 * without opening the page. `--quiet` turns it off.
 *
 * @module
 */

import type { KeyCheck } from '@theoremjs/agents';
import type { StudioDescription } from './handler.ts';

/** What the project loaded, and from where, as the lines the command prints first. */
export function loadedText(
  description: StudioDescription,
  at: { entry?: string; keys: 'checking' | 'offline' },
): string {
  const { agents, toolSpecs } = description.workspace;
  const agentList = agents.map((agent) => {
    const providers = [...new Set(agent.modelBindings.map((binding) => binding.provider))];
    const type = agent.identity.profileType || 'no type';
    return `${agent.identity.agentId || agent.key} (${[type, ...providers].join(', ')})`;
  });
  const kinds = new Map<string, number>();
  for (const tool of toolSpecs) kinds.set(tool.toolType, (kinds.get(tool.toolType) ?? 0) + 1);
  const tools = [...kinds].map(([kind, count]) => `${count} ${kind}`).join(', ');
  const named = new Set(agents.flatMap((agent) => agent.modelBindings.map((b) => b.provider)));
  const keys =
    named.size === 0
      ? 'no model names a provider'
      : at.keys === 'offline'
        ? 'not checked (--offline)'
        : `checking ${[...named].join(', ')}…`;
  return [
    `theorem studio: ${description.project}`,
    `  setup   ${description.setup ?? 'none'}${at.entry ? ` → entry ${at.entry}` : ''}`,
    `  agents  ${agentList.join('; ') || 'none'}`,
    `  tools   ${tools || 'none'}`,
    `  keys    ${keys}`,
  ].join('\n');
}

/** What one provider said of its key, as a line for the terminal. Never the key. */
export function keyLine(check: KeyCheck): string {
  const slot = check.slot ? ` (${check.slot})` : '';
  const status = check.status === undefined ? '' : ` ${check.status}`;
  const said = check.said ? `: ${check.said.replaceAll('\n', ' ')}` : '';
  const what = {
    accepted: 'works',
    refused: `refused${status}${said}`,
    unreachable: `could not be checked${status}${said || ': no answer'}`,
    empty: check.slot ? 'is empty' : 'is in no slot: no model or registration names one',
    unchecked: check.said ? `could not be checked${said}` : 'has no check to ask',
  }[check.state];
  return `theorem studio: key for ${check.provider}${slot} ${what}`;
}

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
