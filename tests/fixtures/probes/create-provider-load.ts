import type { ProviderTurnRequest } from '../../../src/providers/mod.ts';
import {
  defineProvider,
  googleAdapter,
  openAIChat,
  openRouterAdapter,
} from '../../../src/providers/mod.ts';

console.log('PHASE:providers-created');
defineProvider({ id: 'google', connection: {}, adapter: googleAdapter() });
defineProvider({ id: 'router', connection: {}, adapter: openRouterAdapter() });
const local = defineProvider({
  id: 'local',
  connection: { baseURL: 'http://127.0.0.1:8080' },
  adapter: openAIChat(),
});
console.log('PHASE:before-complete');
const operations = await local.adapter.create({
  connection: local.connection,
  providerOptions: {},
  apiId: 'local',
  resolveCredential: () => Promise.resolve(undefined),
  fetch: () =>
    Promise.resolve(
      new Response(
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    ),
  wait: () => Promise.resolve(),
  tapUpstream() {},
});
console.log('PHASE:after-local-complete');
const request: ProviderTurnRequest = {
  model: 'local',
  apiId: 'local',
  system: '',
  input: [{ type: 'text', text: 'hi' }],
  builtins: [],
  structured: null,
  image: null,
};
if (!operations.complete) throw new Error('Missing completion operation');
for await (const event of operations.complete(request)) {
  if (event.type === 'text') console.log('LOCAL_TEXT');
}
console.log('PROBE_DONE');
