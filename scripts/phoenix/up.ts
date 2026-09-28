/**
 * Phoenix prices a span from its own model table, not the span's `llm.cost.total`, and the table
 * has no Jev: without this a Jev decision shows tokens but no cost. It sets the price the kernel
 * records, so Phoenix and `agents eval` agree; rerunning sets it again rather than adding one.
 */

import { JEV_USD_PER_MILLION_INPUT_TOKENS } from '../../src/kernel/engine/decision.ts';

const PHOENIX = 'http://localhost:6006';

/** Phoenix takes a few seconds to answer after its container starts. */
const READY_TRIES = 60;
const READY_WAIT_MS = 1000;

/** Phoenix's entry for Jev: every model TypeSafe answers with (`jev-1.13.0`, ...). */
const JEV_MODEL = {
  name: 'jev',
  provider: 'typesafe',
  namePattern: '^jev-',
  costs: [
    { tokenType: 'input', kind: 'PROMPT', costPerMillionTokens: JEV_USD_PER_MILLION_INPUT_TOKENS },
    { tokenType: 'output', kind: 'COMPLETION', costPerMillionTokens: 0 },
  ],
};

async function graphql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(`${PHOENIX}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`Phoenix answered ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

async function composeUp(): Promise<void> {
  const compose = new URL('./compose.yaml', import.meta.url).pathname;
  const { code } = await new Deno.Command('docker', {
    args: ['compose', '-f', compose, 'up', '-d'],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  if (code !== 0) throw new Error(`docker compose up exited ${code}`);
}

async function waitForPhoenix(): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await graphql('{ __typename }');
      return;
    } catch (error) {
      if (tries === READY_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS));
    }
  }
}

async function priceJev(): Promise<void> {
  const data = (await graphql(
    '{ generativeModels(first: 1000) { edges { node { id name kind } } } }',
  )) as { generativeModels: { edges: { node: { id: string; name: string; kind: string } }[] } };
  const existing = data.generativeModels.edges.find(
    ({ node }) => node.name === JEV_MODEL.name && node.kind === 'CUSTOM',
  );
  if (existing) {
    await graphql(
      'mutation ($input: UpdateModelMutationInput!) { updateModel(input: $input) { __typename } }',
      { input: { id: existing.node.id, ...JEV_MODEL } },
    );
  } else {
    await graphql(
      'mutation ($input: CreateModelMutationInput!) { createModel(input: $input) { __typename } }',
      { input: JEV_MODEL },
    );
  }
  console.log(
    `Phoenix: Jev priced at $${JEV_USD_PER_MILLION_INPUT_TOKENS} per million input tokens, output free; open ${PHOENIX}`,
  );
}

await composeUp();
await waitForPhoenix();
await priceJev();
