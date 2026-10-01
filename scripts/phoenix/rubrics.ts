/**
 * Copy Phoenix's rubrics into `src/evals/rubrics/catalog.ts`: every
 * classification evaluator the running Phoenix serves, verbatim (name,
 * description, labels and their scores, which way is better, and the
 * prompt). Run it after `deno task phoenix:up` whenever the Phoenix image in
 * `compose.yaml` changes; the diff is Phoenix's.
 *
 *   deno task rubrics:sync
 *
 * A prompt this copy cannot use (more than one message, a part that is not
 * text, Mustache THEOREM does not render, no `<data>` block to put a decision
 * judge's state in) stops the sync and names it, so a Phoenix upgrade that
 * changes the shape is read before any suite runs on it.
 *
 * @module
 */

import { templatePaths } from '../../src/evals/rubrics/mustache.ts';

const PHOENIX = 'http://localhost:6006';
const CATALOG = new URL('../../src/evals/rubrics/catalog.ts', import.meta.url).pathname;

const QUERY = `{
  classificationEvaluatorConfigs {
    name description optimizationDirection choices
    messages { role content { __typename ... on TextContentPart { text { text } } } }
  }
}`;

interface PhoenixConfig {
  name: string;
  description: string | null;
  optimizationDirection: string;
  choices: Record<string, unknown>;
  messages: { role: string; content: { __typename: string; text?: { text: string } }[] }[];
}

const DIRECTIONS = ['MAXIMIZE', 'MINIMIZE', 'NONE'];

function refuse(name: string, message: string): never {
  throw new Error(`Phoenix rubric ${name}: ${message}`);
}

/** The one prompt a config carries, checked for everything the judge relies on. */
function promptOf(config: PhoenixConfig): string {
  const [message, ...more] = config.messages;
  if (!message || more.length > 0 || message.role !== 'USER') {
    refuse(config.name, 'has more than one message, or none from the user');
  }
  if (message.content.some((part) => part.__typename !== 'TextContentPart' || !part.text)) {
    refuse(config.name, 'has a part that is not text');
  }
  const template = message.content.map((part) => part.text?.text ?? '').join('');
  if ((template.match(/<data>/g) ?? []).length !== 1 || !template.includes('</data>')) {
    refuse(config.name, 'has no single <data> block');
  }
  templatePaths(template);
  return template;
}

function checkConfig(config: PhoenixConfig): void {
  if (!DIRECTIONS.includes(config.optimizationDirection)) {
    refuse(config.name, `optimizes ${config.optimizationDirection}`);
  }
  const scores = Object.values(config.choices);
  if (scores.length < 2 || scores.some((score) => typeof score !== 'number')) {
    refuse(config.name, 'needs two or more labels, each with a number');
  }
}

/** A template literal holding the text as is. */
function literal(text: string): string {
  return `\`${text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``;
}

async function phoenix(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${PHOENIX}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `Phoenix answered ${response.status} on ${path}; is \`deno task phoenix:up\` running?`,
    );
  }
  return response;
}

const version = (await (await phoenix('/arize_phoenix_version')).text()).trim();
const body = await (
  await phoenix('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  })
).json();
if (body.errors) throw new Error(`Phoenix answered ${JSON.stringify(body.errors)}`);
const configs = (body.data.classificationEvaluatorConfigs as PhoenixConfig[]).toSorted((a, b) =>
  a.name.localeCompare(b.name),
);

const entries = configs.map((config) => {
  checkConfig(config);
  const template = promptOf(config);
  return `  {
    name: ${JSON.stringify(config.name)},
    description: ${JSON.stringify(config.description ?? '')},
    direction: ${JSON.stringify(config.optimizationDirection)},
    labels: ${JSON.stringify(config.choices)},
    template: ${literal(template)},
  },`;
});

await Deno.writeTextFile(
  CATALOG,
  `/**
 * Phoenix's rubrics, copied verbatim from Phoenix ${version} by
 * \`deno task rubrics:sync\` (\`scripts/phoenix/rubrics.ts\`). Do not edit by
 * hand: run the sync against a newer Phoenix instead.
 *
 * The prompts are Arize Phoenix's (\`@arizeai/phoenix-evals\`), Copyright
 * Arize AI, Inc., Apache License 2.0.
 *
 * @module
 */

/** One Phoenix classification evaluator, as Phoenix serves it. */
export interface PhoenixRubric {
  name: string;
  description: string;
  /** Which way is better: toward the highest score, the lowest, or neither. */
  direction: 'MAXIMIZE' | 'MINIMIZE' | 'NONE';
  labels: Readonly<Record<string, number>>;
  /** The Mustache prompt; its one \`<data>\` block holds what the judge reads. */
  template: string;
}

/** Every rubric Phoenix serves, by name. */
export const PHOENIX_RUBRICS = [
${entries.join('\n')}
] as const satisfies readonly PhoenixRubric[];
`,
);
const format = await new Deno.Command('npx', {
  args: ['biome', 'check', '--write', CATALOG],
  stdout: 'null',
  stderr: 'inherit',
}).output();
if (format.code !== 0) throw new Error(`biome exited ${format.code} on ${CATALOG}`);
console.log(`${configs.length} rubrics copied from Phoenix ${version} to ${CATALOG}`);
