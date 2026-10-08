import type { TraceSink } from '../observability/trace-sink.ts';
import type { RunDecisionOptions } from './engine/decision.ts';
import type { RunSessionOptions } from './engine/session/mod.ts';
import type {
  ProviderDefinition,
  ProviderHostOptions,
  RegisteredProvider,
} from './provider-contract.ts';
import type { ProfileDefinition } from './registry/profiles.ts';
import { defaultKernelScope as scope } from './scope.ts';
import type { InvokeToolRequest, RegisteredTool, ToolDefinitionInput } from './tools/types.ts';
import type {
  CompactHistoryRequest,
  CompactionResult,
  DecisionRequest,
  DecisionResult,
  LiveSession,
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

/** Register or replace several tools in the default scope. */
function registerTools(defs: ToolDefinitionInput[]): RegisteredTool[] {
  return scope.tools.registerMany(defs);
}

/** The default scope's tool `name`, or `undefined`. */
function getTool(name: string): RegisteredTool | undefined {
  return scope.tools.get(name);
}

/** The default scope's tool `name`; throws when there is none. */
function requireTool(name: string): RegisteredTool {
  return scope.tools.require(name);
}

/** True when the default scope has a tool `name`. */
function hasTool(name: string): boolean {
  return scope.tools.has(name);
}

/** Every tool in the default scope. */
function listTools(): RegisteredTool[] {
  return scope.tools.list();
}

/** Remove every tool from the default scope. */
function resetTools(): void {
  scope.tools.reset();
}

/** Define, validate, and register a profile in the default scope. */
function registerProfile(profile: Profile | ProfileDefinition): void {
  scope.profiles.register(profile);
}

/** Define, validate and register several profiles in the default scope. */
function registerProfiles(profiles: Array<Profile | ProfileDefinition>): void {
  scope.profiles.registerMany(profiles);
}

/** The default scope's profile `id`; throws when there is none. */
function getProfile(id: string): Profile {
  return scope.profiles.get(id);
}

/** True when the default scope has a profile `id`. */
function hasProfile(id: string): boolean {
  return scope.profiles.has(id);
}

/** Every profile in the default scope. */
function listProfiles(): Profile[] {
  return scope.profiles.list();
}

/** Remove every profile from the default scope. */
function clearProfiles(): void {
  scope.profiles.clear();
}

/** Register a structured-output schema in the default scope under `id`. */
function registerStructured(id: string, spec: StructuredSpec): void {
  scope.schemas.register(id, spec);
}

/** The default scope's schema `id`; throws when there is none. */
function getStructured(id: string): StructuredSpec {
  return scope.schemas.get(id);
}

/** Run one turn of a profile in the default scope, streaming its events. */
function runTurn(
  req: TurnRequest,
  options: ProviderHostOptions = {},
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  return scope.runTurn(req, options, sinkOverride);
}

/** Open a live session for a live profile in the default scope. */
function runSession(
  req: SessionRequest,
  options: RunSessionOptions,
  sinkOverride?: TraceSink,
): Promise<LiveSession> {
  return scope.runSession(req, options, sinkOverride);
}

/** Compact a conversation history with the model, or `undefined` when there is nothing to compact. */
function compactHistory(
  req: CompactHistoryRequest,
  options: ProviderHostOptions = {},
  sinkOverride?: TraceSink,
): Promise<CompactionResult | undefined> {
  return scope.compactHistory(req, options, sinkOverride);
}

/** Run a held tool call in the default scope, streaming the events of the turn it resumes. */
function invokeTool(
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  return scope.invokeTool(request, sinkOverride);
}

/** Resolve a turn request in the default scope: its profile, model and generation settings. */
function resolveTurn(req: TurnRequest): ReturnType<typeof scope.resolveTurn> {
  return scope.resolveTurn(req);
}

/** The profile `id` projected for a client, with server-only fields removed. */
function projectProfile(id: string): ProjectedProfile {
  return scope.projectProfile(id);
}

/** Answer a decision request with the profile's model in the default scope. */
function runDecision(
  request: DecisionRequest,
  options: RunDecisionOptions,
): Promise<DecisionResult> {
  return scope.runDecision(request, options);
}

export {
  clearProfiles,
  compactHistory,
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

export function registerProvider<C, O, K, S>(
  definition: ProviderDefinition<C, O, K, S>,
): RegisteredProvider {
  return scope.providers.register(definition);
}
export function registerProviders(definitions: ProviderDefinition[]): RegisteredProvider[] {
  return scope.providers.registerMany(definitions);
}
export function getProvider(id: string): RegisteredProvider | undefined {
  return scope.providers.get(id);
}
export function requireProvider(id: string): RegisteredProvider {
  return scope.providers.require(id);
}
export function hasProvider(id: string): boolean {
  return scope.providers.has(id);
}
export function listProviders(): RegisteredProvider[] {
  return scope.providers.list();
}
export function resetProviders(): void {
  scope.providers.reset();
}
