/**
 * Tool registry types — single catalog, shared execution.
 *
 * Closed unions (`TOOL_*`) live in `../schema.ts`. This module owns the
 * structural contracts built on those unions.
 *
 * @module
 */

import type { z } from 'zod';
import type { ToolCredential } from '../auth/types.ts';
import type {
  AuthUnauthenticatedPolicy,
  HttpMethod,
  LiveToolLoadTier,
  ToolAccess,
  ToolAuthType,
  ToolLoadTier,
  ToolPermission,
} from '../schema.ts';
import type { Profile, ToolId, TurnInput } from '../types.ts';

export type {
  AuthUnauthenticatedPolicy,
  HttpMethod,
  LiveToolLoadTier,
  ToolAccess,
  ToolAuthType,
  ToolPermission,
};

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
  credentials?: Record<string, ToolCredential>;
}

export interface ToolFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolPause {
  kind: 'interactive' | 'confirmation' | 'permission' | 'auth';
  tool: string;
  render?: InteractiveRender;
  summary?: string;
  input: unknown;
  permission?: ToolPermission;
  /** Auth challenge metadata when kind is 'auth' */
  authChallenge?: {
    slot: string;
    authType: ToolAuthType;
    message: string;
    authorizationUrl?: string;
    state?: string;
    issuer?: string;
    resource?: string;
    requiredScopes?: string[];
  };
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

export interface HttpToolAuthConfig {
  slot: string;
  type: ToolAuthType;
  headerName?: string; // defaults to 'Authorization'
  headerPrefix?: string; // defaults to 'Bearer '
  onUnauthenticated?: AuthUnauthenticatedPolicy; // defaults to 'pause'
  /** Pre-resolved AS/resource metadata to bypass network discovery */
  preResolved?: {
    issuer?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    resource?: string;
  };
  scopes?: string[];
  clientId?: string;
  redirectUri?: string;
}

export interface HttpToolDef<TIn = unknown, TOut = unknown> extends ToolBase {
  type: 'http';
  endpoint: string; // URL template, e.g. "https://api.example.com/items/{id}"
  method: HttpMethod;
  headers?: Record<string, string>;
  auth?: HttpToolAuthConfig;
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  mapping?: {
    pathParams?: string[];
    queryParams?: string[];
    bodyParam?: string;
  };
  interactive?: InteractiveConfig<TIn>;
  canExecute?: (input: TIn, ctx: ToolContext) => boolean | Promise<boolean>;
  preflight?: (
    input: TIn,
    ctx: ToolContext,
  ) => undefined | ToolFailure | ToolPause | Promise<undefined | ToolFailure | ToolPause>;
  exposeToModel?: boolean;
}

export interface McpToolDef<TIn = unknown, TOut = unknown> extends ToolBase {
  type: 'mcp';
  serverUrl: string; // HTTP MCP server endpoint URL
  mcpToolName: string; // Name of the tool on the remote MCP server
  headers?: Record<string, string>;
  auth?: HttpToolAuthConfig;
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
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
  | FunctionToolDef<TIn, TOut>
  | HttpToolDef<TIn, TOut>
  | McpToolDef<TIn, TOut>;

export type ToolDefinitionInput<TIn = unknown, TOut = unknown> =
  | BuiltinToolDef
  | (Omit<FunctionToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType<TIn>;
      output: z.ZodType<TOut>;
    })
  | (Omit<HttpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType<TIn>;
      output: z.ZodType<TOut>;
    })
  | (Omit<McpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
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
  /** Selected model id — same as `TurnRequest.model` (builtins resolve from that model). */
  model?: string;
  /**
   * Optional turn snapshot from a paused turn. Cloned before use so concurrent host
   * invokes do not share mutable visibility state.
   */
  snapshot?: TurnToolSnapshot;
  resume?: InvokeToolResume;
  sessionPermissions?: string[];
  /** Host credentials for authenticated HTTP / MCP tools keyed by auth slot. */
  credentials?: Record<string, ToolCredential>;
  path?: string;
  signal?: AbortSignal;
}

export interface ProfileToolsSpec {
  /** Custom function tools this profile may run. Builtins live on models.*.builtInTools. */
  allow: ToolId[];
  /**
   * Optional T1 policy — returns which eligible T1 tools to wire at turn start.
   * Tools must already be on `allow` (custom) or `builtInTools` (builtin) and `loadTier: 'T1'`.
   * Not supported on `type: 'live'` (Gemini Live wires declarations once at session setup).
   */
  t1Policy?: ToolPolicy;
  /**
   * Optional designated function tool id for T2 promotion.
   * Must be in `allow`. When that tool completes with `{ loaded: string[] }`, those T2 ids are promoted.
   * Not supported on `type: 'live'`.
   */
  t2Loader?: ToolId;
}

/**
 * Live session tools — Gemini Live (and similar) fix function declarations at setup.
 *
 * Shape excludes `t1Policy` / `t2Loader`. Every id in `allow` (and each model's
 * `builtInTools`) must resolve to a registered tool with {@link LiveToolLoadTier}
 * (`T0`) — `registerProfile` rejects T1/T2.
 */
export interface LiveProfileToolsSpec {
  /** Custom T0 tools wired once at session setup. */
  allow: ToolId[];
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
