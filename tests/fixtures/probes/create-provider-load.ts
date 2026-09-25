import type { ProviderCompleteRequest } from '../../../src/kernel/types.ts';
import { createProvider } from '../../../src/providers/create-provider.ts';
import { stubProfile } from '../profiles.ts';

function baseProfile(
  model: {
    protocol: 'geminiInteractions' | 'openAi';
    provider: 'google' | 'openrouter' | 'local';
  },
  speech: boolean,
) {
  return stubProfile({
    protocol: model.protocol,
    provider: model.provider,
    role: speech ? 'speech' : 'text',
    id: 'probe-profile',
  });
}

function localCompleteRequest(): ProviderCompleteRequest {
  return {
    model: 'local-model',
    apiId: 'llama3.2',
    thinking: 'none',
    summaries: undefined,
    maxOutputTokens: 256,
    temperature: 0.2,
    builtins: [],
    system: 'Be brief.',
    input: [{ type: 'text', text: 'Hello' }],
    structured: null,
    image: null,
  };
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

console.log('PHASE:providers-created');

createProvider(baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, false), {
  gemini: { vault: { slotA: 'a', slotB: 'b', slotC: 'c', paid: 'p' } },
});
createProvider(baseProfile({ protocol: 'openAi', provider: 'openrouter' }, false), {
  openAiGateway: { apiKey: 'key' },
});
createProvider(baseProfile({ protocol: 'openAi', provider: 'openrouter' }, true), {
  openAiGateway: { apiKey: 'key', voice: 'Kore' },
});
createProvider(baseProfile({ protocol: 'openAi', provider: 'local' }, false), {});

console.log('PHASE:before-complete');

const local = createProvider(baseProfile({ protocol: 'openAi', provider: 'local' }, false), {
  local: {
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  },
});

console.log('PHASE:after-local-complete');

for await (const _ of local.complete(localCompleteRequest())) {
  // drain one local turn to force the lazy adapter import
}

console.log('PROBE_DONE');
