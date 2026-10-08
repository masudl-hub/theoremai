import { createKernelScope, defineProfile, defineProvider, openAIChat } from '../../../mod.ts';

const scope = createKernelScope();
const provider = defineProvider({
  id: 'local',
  connection: { baseURL: 'http://127.0.0.1:9' },
  adapter: openAIChat(),
});
scope.providers.register(provider);
scope.profiles.register(
  defineProfile({
    id: 'zero-perm-bot',
    type: 'text',
    identity: { handle: 'z' },
    tools: { allow: [] },
    inputs: { text: true },
    models: { default: provider.model('model') },
  }),
);
console.log('ZERO_PERM_OK');
