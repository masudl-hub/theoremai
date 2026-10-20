import { defineProfile } from '@theoremjs/agents';

// Two agents to a file, and a third after them.

export const concierge = defineProfile({
  id: 'concierge',
  type: 'text',
  identity: { handle: 'Concierge', system: 'Answer in one line.' },
  models: { main: { protocol: 'openAi', provider: 'left', apiId: 'left/model', efforts: { normal: 'minimal' } } },
  defaultModel: 'main',
  tools: { allow: ['lookup_city', 'fetch_rates'] },
  inputs: { text: true },
});

export const gatekeeper = defineProfile({ type: 'host', id: 'gatekeeper', tools: { allow: ['lookup_city', 'wipe_desk'] } });

export const triage = defineProfile({
  type: 'decision',
  id: 'triage',
  identity: { handle: 'triage' },
  models: { jev: { protocol: 'systemOne', provider: 'spaced', apiId: 'jev-latest', timeoutMs: 1000 } },
  inputs: { state: 'json', maxStateBytes: 2000 },
  decision: { contract: 'triage.v1' },
});
