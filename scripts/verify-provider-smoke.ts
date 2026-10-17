#!/usr/bin/env -S deno run --allow-net --allow-sys --allow-env --allow-read

import { createKernelScope, defineProfile, openRouter, openRouterProvider } from '../mod.ts';
import { hostOpenRouterKey, hostVault, loadHostEnv, OPENROUTER_ENV } from './host-env.ts';

function valueAfterFlag(flag: string): string | undefined {
  const idx = Deno.args.indexOf(flag);
  return idx < 0 ? undefined : Deno.args[idx + 1];
}

loadHostEnv();
const apiKey = hostOpenRouterKey();
const apiId = valueAfterFlag('--api-id') ?? 'openrouter/free';
const model = valueAfterFlag('--model') ?? 'smoke';
if (!apiKey) {
  console.error(
    `Error: ${OPENROUTER_ENV} unset. This script reads it; Theorem itself never reads env.`,
  );
  Deno.exit(1);
}

const scope = createKernelScope();
const provider = scope.providers.register(openRouterProvider, {
  id: 'smoke-router',
  connection: { siteUrl: 'https://theorem.agent', siteName: 'Theorem Provider Smoke' },
  keySlot: 'openrouter',
});
scope.profiles.register(
  defineProfile({
    id: 'smoke',
    type: 'text',
    identity: {
      handle: 'Smoke',
      system: 'You are a precise verification assistant. Answer briefly.',
    },
    models: { [model]: provider.model(openRouter, apiId, { maxOutputTokens: 1024 }) },
    inputs: { text: true },
    tools: { allow: [] },
  }),
);

try {
  let text = '';
  let tokens = 0;
  let completed = false;
  let failed = false;
  for await (const event of scope.runTurn(
    {
      profile: 'smoke',
      input: { text: 'Reply exactly THEOREM_SMOKE_OK.' },
      signal: AbortSignal.timeout(60000),
    },
    { vault: { ...hostVault(), openrouter: apiKey } },
  )) {
    if (event.type === 'text') text += event.text;
    if (event.type === 'tokens') tokens += event.tokens.total;
    if (event.type === 'done') completed = event.stop.kind === 'completed';
    if (event.type === 'error') failed = true;
  }
  if (!completed || failed || text.trim() !== 'THEOREM_SMOKE_OK') {
    throw new Error('Registered provider did not return the expected successful reply');
  }
  console.log(
    JSON.stringify({ provider: provider.id, apiId, passed: true, text: text.trim(), tokens }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Provider smoke failed');
  Deno.exitCode = 1;
}
