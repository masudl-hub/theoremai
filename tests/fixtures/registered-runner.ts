import type { KeyVault } from '../../src/kernel/registry/vault.ts';
import { defaultKernelScope, type KernelScope } from '../../src/kernel/scope.ts';
import type { CompactHistoryRequest, TurnModel, TurnRequest } from '../../src/kernel/types.ts';
import type { TraceSink } from '../../src/observability/trace-sink.ts';
import { registerFixtureProviders } from './provider-scope.ts';
import { scriptedFetch } from './scripted.ts';

registerFixtureProviders(defaultKernelScope);

/** The fixture bindings' slots, each holding a placeholder the scripted provider signs with. */
export const FIXTURE_VAULT: KeyVault = { slot_a: 'key-a', slot_b: 'key-b', slot_c: 'key-c' };

/** Host options under which the scripted protocol's calls are answered by `model`. */
export function fixtureHostOptions(model: TurnModel) {
  return { fetch: scriptedFetch(model), vault: FIXTURE_VAULT };
}
export function runTurn(request: TurnRequest, model: TurnModel, sink?: TraceSink) {
  return defaultKernelScope.runTurn(request, fixtureHostOptions(model), sink);
}
export function compactHistory(request: CompactHistoryRequest, model: TurnModel, sink?: TraceSink) {
  return defaultKernelScope.compactHistory(request, fixtureHostOptions(model), sink);
}
export function runScopedTurn(
  scope: KernelScope,
  request: TurnRequest,
  model: TurnModel,
  sink?: TraceSink,
) {
  return scope.runTurn(request, fixtureHostOptions(model), sink);
}
