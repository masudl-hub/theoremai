import { defineProvider } from '../../src/kernel/provider-contract.ts';
import { createKernelScope, type KernelScope } from '../../src/kernel/scope.ts';
import {
  googleAdapter,
  openAIChat,
  openRouterAdapter,
  typesafeAdapter,
} from '../../src/providers/adapters.ts';
export function registerFixtureProviders(scope: KernelScope) {
  if (!scope.providers.has('google'))
    scope.providers.register(
      defineProvider({ id: 'google', connection: {}, keySlot: 'slot_a', adapter: googleAdapter() }),
    );
  if (!scope.providers.has('openrouter'))
    scope.providers.register(
      defineProvider({
        id: 'openrouter',
        connection: {},
        keySlot: 'slot_a',
        adapter: openRouterAdapter(),
      }),
    );
  if (!scope.providers.has('typesafe'))
    scope.providers.register(
      defineProvider({
        id: 'typesafe',
        connection: {},
        keySlot: 'slot_a',
        adapter: typesafeAdapter(),
      }),
    );
  if (!scope.providers.has('local'))
    scope.providers.register(
      defineProvider({
        id: 'local',
        connection: { baseURL: 'http://localhost:11434/v1' },
        adapter: openAIChat(),
      }),
    );
}
export function createTestKernelScope(): KernelScope {
  const scope = createKernelScope();
  registerFixtureProviders(scope);
  return scope;
}
