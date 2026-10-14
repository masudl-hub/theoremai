import { assertEquals } from '@std/assert';
import { createKernelScope, defineProfile, defineProvider, openAIChat, z } from '../../mod.ts';

function scoped(clientTools: 'supported' | 'unknown') {
  const scope = createKernelScope();
  scope.providers.register(
    defineProvider({
      id: 'plain',
      connection: { baseURL: 'https://plain.example/v1' },
      adapter: openAIChat({
        capabilities: {
          profileTypes: ['text'],
          inputKinds: ['text'],
          outputKinds: ['text'],
          builtins: [],
          features: {
            streaming: 'supported',
            clientTools,
            parallelTools: 'unknown',
            structuredOutput: 'unknown',
            thinking: 'unknown',
            summaries: 'unknown',
            storedContinuation: 'unsupported',
          },
        },
      }),
    }),
  );
  scope.tools.register({
    type: 'function',
    name: 'look',
    description: 'Look something up',
    category: 'test',
    access: 'read-only',
    permission: 'auto',
    paths: ['*'],
    loadTier: 'T0',
    input: z.strictObject({}),
    output: z.strictObject({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
  scope.profiles.register(
    defineProfile({
      id: 'desk',
      type: 'text',
      identity: { handle: 'Desk' },
      models: {
        bare: { provider: 'plain', apiId: 'plain/model' },
        thinking: { provider: 'plain', apiId: 'plain/model', efforts: { normal: 'high' } },
      },
      defaultModel: 'bare',
      tools: { allow: ['look'] },
      inputs: { text: true },
      outputs: {},
      guardrails: {},
      turnBehaviour: {},
      observability: {},
      labels: {},
    }),
  );
  return scope;
}

Deno.test('a model whose provider cannot run its tools or its thinking is named, each once', () => {
  const scope = scoped('unknown');
  assertEquals(
    scope.turnShortfalls('desk').map((shortfall) => shortfall.model),
    ['bare', 'thinking'],
  );
});

Deno.test('a model its provider can run, and an unknown agent, have no shortfall', () => {
  const scope = scoped('supported');
  assertEquals(
    scope.turnShortfalls('desk').map((shortfall) => shortfall.model),
    ['thinking'],
  );
  assertEquals(scope.turnShortfalls('nobody'), []);
});

Deno.test('an image agent that takes no text is still checked', () => {
  const scope = scoped('unknown');
  scope.providers.register(
    defineProvider({
      id: 'painter',
      connection: {},
      adapter: {
        apiVersion: 1,
        id: 'painter',
        connectionSchema: z.object({}),
        optionsSchema: z.object({}),
        credentialSchema: z.string(),
        capabilities: () => ({
          profileTypes: ['image'],
          inputKinds: ['text', 'image'],
          outputKinds: ['text', 'image'],
          builtins: [],
          features: {
            streaming: 'supported',
            clientTools: 'unknown',
            parallelTools: 'unknown',
            structuredOutput: 'unknown',
            thinking: 'unknown',
            summaries: 'unknown',
            storedContinuation: 'unsupported',
          },
        }),
        validateRequest() {},
        create: () => Promise.resolve({}),
      },
    }),
  );
  scope.profiles.register(
    defineProfile({
      id: 'studio',
      type: 'image',
      identity: { handle: 'Studio' },
      models: { paint: { provider: 'painter', apiId: 'painter/model' } },
      defaultModel: 'paint',
      image: { aspectRatio: '1:1', resolution: '1K', mimeType: 'image/png', includeText: false },
      tools: { allow: ['look'] },
      inputs: {
        text: false,
        attachments: { accept: ['image/png'] },
        maxFiles: 1,
        maxBytes: 1_000_000,
        maxTurnBytes: 1_000_000,
      },
      outputs: { structured: null },
    }),
  );
  assertEquals(
    scope.turnShortfalls('studio').map((shortfall) => shortfall.model),
    ['paint'],
  );
});
