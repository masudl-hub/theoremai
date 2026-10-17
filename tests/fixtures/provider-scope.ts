import { createKernelScope, type KernelScope } from '../../src/kernel/scope.ts';
import { geminiProvider } from '../../src/providers/gemini/provider.ts';
import { localProvider } from '../../src/providers/local/provider.ts';
import { openRouterProvider } from '../../src/providers/openrouter/provider.ts';
import { typesafeProvider } from '../../src/providers/typesafe/provider.ts';
import { scriptedProvider } from './scripted.ts';

/**
 * Registers the real providers, and the scripted one that engine tests bind to. `scripted_b` is the
 * same provider under a second id, for a test that needs two.
 */
export function registerFixtureProviders(scope: KernelScope) {
  if (!scope.providers.get('scripted'))
    scope.providers.register(scriptedProvider, { keySlot: 'slot_a' });
  if (!scope.providers.get('scripted_b'))
    scope.providers.register(scriptedProvider, { id: 'scripted_b', keySlot: 'slot_b' });
  if (!scope.providers.get('gemini'))
    scope.providers.register(geminiProvider, { keySlot: 'slot_a' });
  if (!scope.providers.get('openrouter'))
    scope.providers.register(openRouterProvider, { keySlot: 'slot_a' });
  if (!scope.providers.get('typesafe'))
    scope.providers.register(typesafeProvider, { keySlot: 'slot_a' });
  if (!scope.providers.get('local'))
    scope.providers.register(localProvider, {
      connection: { baseUrl: 'http://localhost:11434/v1' },
    });
}
export function createTestKernelScope(): KernelScope {
  const scope = createKernelScope();
  registerFixtureProviders(scope);
  return scope;
}
