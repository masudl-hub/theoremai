// Spawned by tests/kernel/zero-permission-import.test.ts under `deno run` with every permission denied.
import { createProvider, defineProfile } from '../../../mod.ts';

const profile = defineProfile({
  type: 'text',
  id: 'zero-perm-bot',
  identity: { handle: 'z', system: 'ping' },
  tools: { allow: [] },
  inputs: { text: true },
  models: {
    local: {
      protocol: 'openAi',
      provider: 'local',
      apiId: 'local-model',
      efforts: { normal: 'minimal' },
      summaries: false,
      maxOutputTokens: 128,
      temperature: 1,
      builtInTools: [],
    },
  },
  defaultModel: 'local',
});

const provider = createProvider(profile, {
  local: { baseUrl: 'http://127.0.0.1:9' },
});

if (typeof provider.complete !== 'function') {
  throw new Error('createProvider did not return a complete() provider');
}

console.log('ZERO_PERM_OK');
