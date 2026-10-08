import { z } from 'zod';
import type {
  ProviderCapabilities,
  ProviderModelEvent,
} from '../../src/kernel/provider-contract.ts';
import { defineProvider } from '../../src/kernel/provider-contract.ts';
import { defaultKernelScope, type KernelScope } from '../../src/kernel/scope.ts';
import type {
  CompactHistoryRequest,
  ModelProvider,
  ProviderEvent,
  TurnRequest,
} from '../../src/kernel/types.ts';
import type { TraceSink } from '../../src/observability/trace-sink.ts';
import { translateProviderEvent } from '../../src/providers/adapters.ts';
import { registerFixtureProviders } from './provider-scope.ts';

registerFixtureProviders(defaultKernelScope);
const capabilities: ProviderCapabilities = {
  profileTypes: ['text', 'image', 'speech', 'live', 'decision'],
  features: {
    streaming: 'supported',
    clientTools: 'supported',
    parallelTools: 'supported',
    structuredOutput: 'supported',
    thinking: 'supported',
    summaries: 'supported',
    storedContinuation: 'supported',
  },
  inputKinds: ['text', 'image', 'audio', 'video', 'document'],
  outputKinds: ['text', 'image', 'audio'],
  builtins: ['googleSearch', 'googleMaps', 'urlContext', 'codeExecution'],
};
const nativeAdapters = new Map<string, import('../../mod.ts').RegisteredProvider>();
const fixtures = new WeakMap<typeof fetch, ModelProvider>();
export function fixtureHostOptions(
  provider: ModelProvider,
  scope: KernelScope = defaultKernelScope,
) {
  const send: typeof fetch = () =>
    Promise.reject(new Error('Fixture transport must be consumed by its registered adapter'));
  fixtures.set(send, provider);
  const ids = new Set([
    ...scope.providers.list().map((provider) => provider.id),
    ...scope.profiles
      .list()
      .flatMap((profile) =>
        profile.type === 'host'
          ? []
          : Object.values(profile.models).map((binding) => binding.provider),
      ),
  ]);
  for (const id of ids) {
    const existing = scope.providers.require(id);
    if (existing.adapter.id !== 'runner-fixture') nativeAdapters.set(id, existing);
    const native = nativeAdapters.get(id);
    scope.providers.register(
      defineProvider({
        id,
        keySlot: native?.keySlot,
        fallbackKeySlot: native?.fallbackKeySlot,
        connection: {},
        adapter: {
          apiVersion: 1,
          id: 'runner-fixture',
          connectionSchema: z.strictObject({}),
          optionsSchema: z.record(z.string(), z.json()),
          credentialSchema: z.string(),
          capabilities: () => capabilities,
          validateRequest() {},
          async create(context) {
            const selected = fixtures.get(context.fetch);
            if (!selected && native)
              return await native.adapter.create({ ...context, connection: native.connection });
            if (!selected) throw new Error('Fixture host options are required');
            return {
              async *complete(request): AsyncGenerator<ProviderModelEvent> {
                let terminal = false;
                for await (const event of selected.complete(request)) {
                  const converted = translateProviderEvent(event as ProviderEvent);
                  if (!converted) continue;
                  if (converted.type === 'done') terminal = true;
                  yield converted;
                }
                if (!terminal) yield { type: 'done', stop: { kind: 'completed' } };
              },
            };
          },
        },
      }),
    );
  }
  return { fetch: send };
}
export function runTurn(request: TurnRequest, provider: ModelProvider, sink?: TraceSink) {
  return defaultKernelScope.runTurn(request, fixtureHostOptions(provider), sink);
}
export function compactHistory(
  request: CompactHistoryRequest,
  provider: ModelProvider,
  sink?: TraceSink,
) {
  return defaultKernelScope.compactHistory(request, fixtureHostOptions(provider), sink);
}
export function runScopedTurn(
  scope: KernelScope,
  request: TurnRequest,
  provider: ModelProvider,
  sink?: TraceSink,
) {
  return scope.runTurn(request, fixtureHostOptions(provider, scope), sink);
}
