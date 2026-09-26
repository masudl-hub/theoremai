/**
 * The package's global API: each function acts on `defaultKernelScope`. Hosts
 * that register per request create their own scope with `createKernelScope`
 * and call its methods instead.
 *
 * @module
 */

import type { TraceSink } from '../observability/trace-sink.ts';
import type { RunDecisionOptions } from './engine/decision.ts';
import type { RunSessionOptions } from './engine/session/mod.ts';
import type { ProfileDefinition } from './registry/profiles.ts';
import { defaultKernelScope as scope } from './scope.ts';
import type { InvokeToolRequest, RegisteredTool, ToolDefinitionInput } from './tools/types.ts';
import type {
  DecisionRequest,
  DecisionResult,
  LiveSession,
  ModelProvider,
  Profile,
  ProjectedProfile,
  SessionRequest,
  StructuredSpec,
  TurnEvent,
  TurnRequest,
} from './types.ts';

/** Register or replace a tool in the default scope. */
function registerTool<TIn, TOut>(def: ToolDefinitionInput<TIn, TOut>): RegisteredTool<TIn, TOut> {
  return scope.tools.register(def);
}

/** Register several tools in the default scope, in order. */
function registerTools(defs: ToolDefinitionInput[]): RegisteredTool[] {
  return scope.tools.registerMany(defs);
}

function getTool(name: string): RegisteredTool | undefined {
  return scope.tools.get(name);
}

function requireTool(name: string): RegisteredTool {
  return scope.tools.require(name);
}

function hasTool(name: string): boolean {
  return scope.tools.has(name);
}

function listTools(): RegisteredTool[] {
  return scope.tools.list();
}

function resetTools(): void {
  scope.tools.reset();
}

/** Define, validate, and register a profile in the default scope. */
function registerProfile(profile: Profile | ProfileDefinition): void {
  scope.profiles.register(profile);
}

function registerProfiles(profiles: Array<Profile | ProfileDefinition>): void {
  scope.profiles.registerMany(profiles);
}

/** The default scope's profile `id`; throws when there is none. */
function getProfile(id: string): Profile {
  return scope.profiles.get(id);
}

function hasProfile(id: string): boolean {
  return scope.profiles.has(id);
}

function listProfiles(): Profile[] {
  return scope.profiles.list();
}

function clearProfiles(): void {
  scope.profiles.clear();
}

/** Register a structured output schema in the default scope. */
function registerStructured(id: string, spec: StructuredSpec): void {
  scope.schemas.register(id, spec);
}

/** The default scope's schema `id`; throws when there is none. */
function getStructured(id: string): StructuredSpec {
  return scope.schemas.get(id);
}

function runTurn(
  req: TurnRequest,
  provider: ModelProvider,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  return scope.runTurn(req, provider, sinkOverride);
}

function runSession(
  req: SessionRequest,
  options: RunSessionOptions,
  sinkOverride?: TraceSink,
): Promise<LiveSession> {
  return scope.runSession(req, options, sinkOverride);
}

function invokeTool(
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  return scope.invokeTool(request, sinkOverride);
}

function resolveTurn(req: TurnRequest): ReturnType<typeof scope.resolveTurn> {
  return scope.resolveTurn(req);
}

function projectProfile(id: string): ProjectedProfile {
  return scope.projectProfile(id);
}

function runDecision(
  request: DecisionRequest,
  options: RunDecisionOptions,
): Promise<DecisionResult> {
  return scope.runDecision(request, options);
}

export {
  clearProfiles,
  getProfile,
  getStructured,
  getTool,
  hasProfile,
  hasTool,
  invokeTool,
  listProfiles,
  listTools,
  projectProfile,
  registerProfile,
  registerProfiles,
  registerStructured,
  registerTool,
  registerTools,
  requireTool,
  resetTools,
  resolveTurn,
  runDecision,
  runSession,
  runTurn,
};
