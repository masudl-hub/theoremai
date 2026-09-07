/**
 * Tool registry types — single catalog, shared execution.
 *
 * Closed unions (`TOOL_*`) live in `../schema.ts`. This module owns the
 * structural contracts built on those unions.
 *
 * @module
 */

import type { z } from 'zod';
import type { ToolAccess, ToolLoadTier, ToolPermission } from '../schema.ts';
import type { Profile, ToolId, TurnInput } from '../types.ts';

export type { ToolAccess, ToolPermission };

export interface ToolLabels {
  activity?: string;
  activityPast?: string;
  hiddenFromSettings?: boolean;
}

export interface ToolBase {
  name: string;
  description: string;
  category: string;
  access: ToolAccess;
  paths: string[];
  loadTier: ToolLoadTier;
  permission: ToolPermission;
  labels?: ToolLabels;
}

export interface BuiltinWire {
  interactions?: string;
  openRouter?: string;
  live?: string;
}

export interface BuiltinToolDef extends ToolBase {
  type: 'builtin';
  wire: BuiltinWire;
  conflictsWith?: string[];
  /** When enabled, select the paid Vault key slot unless model.spec.key overrides. */
  forcePaidKey?: boolean;
}

export interface InteractiveRender {
  kind: string;
  prompt: string;
  options?: string[];
  [key: string]: unknown;
}

export interface InteractiveConfig<TIn = unknown> {
  render: (input: TIn) => InteractiveRender;
}

export interface InvokeToolResume {
  value?: unknown;
  granted?: boolean;
}

export interface ToolContext {
  profile: Profile;
  callId: string;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
  turn?: { step: number };
  resume?: InvokeToolResume;
}

export interface ToolFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolPause {
  kind: 'interactive' | 'confirmation' | 'permission';
  tool: string;
  render?: InteractiveRender;
  summary?: string;
  input: unknown;
  permission?: ToolPermission;
}

export interface ToolWarning {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface ToolTraceStep {
  name: string;
  kind: string;
  status: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export type ToolStreamEvent<TOut = unknown> =
  | { kind: 'progress'; data: unknown }
  | { kind: 'trace'; step: ToolTraceStep }
  | { kind: 'artifact'; artifact: unknown }
  | { kind: 'warning'; warning: ToolWarning }
  | { kind: 'complete'; output: TOut };

export type SyncToolHandler<TIn, TOut> = (input: TIn, ctx: ToolContext) => TOut | Promise<TOut>;
export type StreamToolHandler<TIn, TOut> = (
  input: TIn,
  ctx: ToolContext,
) => AsyncGenerator<ToolStreamEvent<TOut>>;

export type ToolHandler<TIn, TOut> = SyncToolHandler<TIn, TOut> | StreamToolHandler<TIn, TOut>;

export interface FunctionToolDef<TIn = unknown, TOut = unknown> extends ToolBase {
  type: 'function';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  handler: ToolHandler<TIn, TOut>;
  interactive?: InteractiveConfig<TIn>;
  canExecute?: (input: TIn, ctx: ToolContext) => boolean | Promise<boolean>;
  preflight?: (
    input: TIn,
    ctx: ToolContext,
  ) => undefined | ToolFailure | ToolPause | Promise<undefined | ToolFailure | ToolPause>;
  exposeToModel?: boolean;
}

export type RegisteredTool<TIn = unknown, TOut = unknown> =
  | BuiltinToolDef
  | FunctionToolDef<TIn, TOut>;

export type ToolDefinitionInput<TIn = unknown, TOut = unknown> =
  | BuiltinToolDef
  | (Omit<FunctionToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType<TIn>;
      output: z.ZodType<TOut>;
    });

export interface WireFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TurnToolSnapshot {
  builtins: ToolId[];
  /** Tool ids eligible this turn (custom: allow + path; builtin: model builtInTools + path). */
  gated: ToolId[];
  /** Schemas sent to the provider (respects loadTier + t2Loader promotion). */
  visible: ToolId[];
  /** Kernel-executable tools: eligible, visible, and loaded (excludes builtins). */
  executable: ToolId[];
  path?: string;
  sessionPermissions?: string[];
  wire: WireFunctionTool[];
}

export interface PromoteLoadedResult {
  promoted: ToolId[];
  failure?: ToolFailure;
}

/** Context for profile T1 tool selection via `profile.tools.t1Policy`. */
export interface ToolLoadContext {
  profile: Profile;
  input?: TurnInput;
  path?: string;
  sessionPermissions?: string[];
  /** Tool ids eligible this turn. */
  gated: ToolId[];
}

/** Profile-owned T1 selection — which eligible T1 tools to wire at turn start. */
export type ToolPolicy = (ctx: ToolLoadContext) => ToolId[] | Promise<ToolId[]>;

export interface InvokeToolRequest {
  profile: string;
  name: string;
  input: unknown;
  /** Turn input context for `profile.tools.t1Policy` selection (same as `TurnRequest.input`). */
  turnInput?: TurnInput;
  /**
   * T2 tools already promoted for this invoke (e.g. restored from pause metadata).
   * Host must have run tools.t2Loader (or equivalent) before listing ids here.
   */
  promoted?: ToolId[];
  /** Model select key — same as `TurnRequest.select` (builtins resolve from that model). */
  select?: string;
  /**
   * Optional turn snapshot from a paused turn. Cloned before use so concurrent host
   * invokes do not share mutable visibility state.
   */
  snapshot?: TurnToolSnapshot;
  resume?: InvokeToolResume;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
}

export interface ProfileToolsSpec {
  /** Custom function tools this profile may run. Builtins live on model specs. */
  allow: ToolId[];
  /**
   * Optional T1 policy — returns which eligible T1 tools to wire at turn start.
   * Tools must already be on `allow` (custom) or `builtInTools` (builtin) and `loadTier: 'T1'`.
   */
  t1Policy?: ToolPolicy;
  /**
   * Optional designated function tool id for T2 promotion.
   * Must be in `allow`. When that tool completes with `{ loaded: string[] }`, those T2 ids are promoted.
   */
  t2Loader?: ToolId;
}

export interface ModelToolResult {
  finding: string;
  data?: unknown;
}

export type ToolCallPhase =
  | 'running'
  | 'progress'
  | 'trace'
  | 'artifact'
  | 'warning'
  | 'complete'
  | 'pause'
  | 'error'
  /** Provider cancelled an in-flight tool call (e.g. live barge-in). */
  | 'cancel';

export interface ToolCallEvent {
  name: string;
  /** Provider-native id or kernel-assigned call id. */
  callId?: string;
  arguments?: Record<string, unknown>;
  /** Absent on raw provider tool-call events; set by kernel execution. */
  phase?: ToolCallPhase;
  data?: unknown;
  step?: ToolTraceStep;
  artifact?: unknown;
  warning?: ToolWarning;
  output?: unknown;
  pause?: ToolPause;
  failure?: ToolFailure;
}
