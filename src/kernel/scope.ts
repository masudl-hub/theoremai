import type { TraceSink } from '../observability/trace-sink.ts';
import { type RunDecisionOptions, runDecisionInRegistry } from './engine/decision.ts';
import { compactHistoryInRegistry, runTurnInRegistry } from './engine/runner/mod.ts';
import { type RunSessionOptions, runSessionInRegistry } from './engine/session/mod.ts';
import { createKernelRegistry, type KernelRegistry } from './registry/kernel-registry.ts';
import { projectProfileInRegistry, resolveTurnInRegistry } from './registry/resolve.ts';
import { invokeTool } from './tools/invoke.ts';
import type { InvokeToolRequest } from './tools/types.ts';
import type {
  CompactHistoryRequest,
  CompactionResult,
  DecisionRequest,
  DecisionResult,
  LiveSession,
  ModelProvider,
  ProjectedProfile,
  SessionRequest,
  TurnEvent,
  TurnRequest,
} from './types.ts';

/** A kernel scope: its registries and the operations that run against them (turns, live sessions, history compaction, tool invocation, turn resolution, profile projection and decisions). */
interface KernelScope extends KernelRegistry {
  runTurn(
    req: TurnRequest,
    provider: ModelProvider,
    sinkOverride?: TraceSink,
  ): AsyncGenerator<TurnEvent>;
  runSession(
    req: SessionRequest,
    options: RunSessionOptions,
    sinkOverride?: TraceSink,
  ): Promise<LiveSession>;
  compactHistory(
    req: CompactHistoryRequest,
    provider: ModelProvider,
    sinkOverride?: TraceSink,
  ): Promise<CompactionResult | undefined>;
  invokeTool(request: InvokeToolRequest, sinkOverride?: TraceSink): AsyncGenerator<TurnEvent>;
  resolveTurn(req: TurnRequest): ReturnType<typeof resolveTurnInRegistry>;
  projectProfile(id: string): ProjectedProfile;
  runDecision(request: DecisionRequest, options: RunDecisionOptions): Promise<DecisionResult>;
}

/** Isolated from every other scope: a host that registers per request gives each its own. */
function createKernelScope(): KernelScope {
  const registry = createKernelRegistry();
  return {
    tools: registry.tools,
    profiles: registry.profiles,
    schemas: registry.schemas,
    runTurn: (req, provider, sinkOverride) =>
      runTurnInRegistry(registry, req, provider, sinkOverride),
    runSession: (req, options, sinkOverride) =>
      runSessionInRegistry(registry, req, options, sinkOverride),
    compactHistory: (req, provider, sinkOverride) =>
      compactHistoryInRegistry(registry, req, provider, sinkOverride),
    invokeTool: (request, sinkOverride) => invokeTool(registry, request, sinkOverride),
    resolveTurn: (req) => resolveTurnInRegistry(registry, req),
    projectProfile: (id) => projectProfileInRegistry(registry, id),
    runDecision: (request, options) => runDecisionInRegistry(registry, request, options),
  };
}

/** The process-wide scope behind the package's global API. */
const defaultKernelScope: KernelScope = createKernelScope();

export type { KernelScope };
export { createKernelScope, defaultKernelScope };
