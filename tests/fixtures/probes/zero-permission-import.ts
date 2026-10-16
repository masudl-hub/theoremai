import { createKernelScope, defineProfile, localProvider, openAi } from '../../../mod.ts';

const scope = createKernelScope();
const local = scope.providers.register(localProvider, {
  connection: { baseUrl: 'http://127.0.0.1:9/v1' },
});
scope.profiles.register(
  defineProfile({
    id: 'zero-perm-bot',
    type: 'text',
    identity: { handle: 'z' },
    tools: { allow: [] },
    inputs: { text: true },
    models: { default: local.model(openAi, 'model') },
  }),
);
console.log('ZERO_PERM_OK');
