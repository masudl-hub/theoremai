/**
 * Probe: import the kernel and construct createProvider with zero ambient
 * authority. Spawned by `tests/kernel/zero-permission-import.test.ts` under
 * `deno run` with every permission denied (`--deny-read` … `--deny-sys`).
 *
 * Deno loads the static module graph without consulting the permission system;
 * this probe asserts construction itself performs no env/net/fs/run/ffi/sys I/O.
 */
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
