/**
 * Tool registry types — single catalog, shared execution.
 *
 * Closed unions (`TOOL_*`) live in `../schema.ts`. This module owns the
 * structural contracts built on those unions.
 *
 * @module
 */

import type { z } from 'zod';
import type { GuardrailHit, Provenance, TurnTaint } from '../../guardrails/types.ts';
import type { ToolCredential } from '../auth/types.ts';
import type {
  AuthUnauthenticatedPolicy,
  HttpMethod,
  ToolAccess,
  ToolAuthType,
  ToolGateKind,
  ToolLoadTier,
  ToolPermission,
} from '../schema.ts';
import type { InteractionPart, Profile, ToolId, TurnInput } from '../types.ts';

export type {
  AuthUnauthenticatedPolicy,
  HttpMethod,
  ToolAccess,
  ToolAuthType,
  ToolGateKind,
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

export interface InvokeToolResume {
  /**
   * Legacy interactive value — unused for gates / ask_user answers.
   * @deprecated Prefer a new user turn for ask_user answers.
   */
  value?: unknown;
  /**
   * Gate resume:
   * - `true` — skip confirm / permission / `preTool` re-ask and run the body
   * - `false` — settle as deny (synthetic failure + `post_tool`, no body)
   * - omit — first attempt (or auth credential retry without grant)
   */
  granted?: boolean;
}

export interface ToolContext {
  profile: Profile;
  callId: string;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
  /** Turn-scoped facts: the step index and what this turn has already ingested. */
  turn?: { step: number; taint?: TurnTaint };
  resume?: InvokeToolResume;
  credentials?: Record<string, ToolCredential>;
  /** Opaque application context from `TurnRequest.host` / `InvokeToolRequest.host`; the kernel never reads it. */
  host?: unknown;
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

/**
 * Confirm-to-run / permission / auth gate (stages contract).
 * Not ask_user / awaiting — those complete the tool. Replaces ToolPause for gates.
 */
export interface ToolGate {
  kind: ToolGateKind;
  tool: string;
  permission?: ToolPermission;
  summary?: string;
  authChallenge?: NonNullable<ToolPause['authChallenge']>;
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

/**
 * Host lifecycle hooks and JSON schemas shared by every kernel-executed tool.
 *
 * Only members that depend on `TIn` live here. `input` and `output` stay declared
 * on each concrete tool so `TOut` is still inferred from `output` rather than from
 * a handler's return type — moving them here silently breaks inference for stream
 * handlers. Builtins are provider-native and do not extend this.
 */
export interface ToolHostHooks<TIn = unknown> {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /**
   * Tool-local `pre_tool` registrant (`docs/contracts/stages.md`).
   * Runs before host `onStage` for `pre_tool`. May return deny / confirm / mutate.
   */
  preTool?: (
    input: TIn,
    ctx: ToolContext,
  ) =>
    | import('../stages.ts').StageResult
    | undefined
    | Promise<import('../stages.ts').StageResult | undefined>;
  exposeToModel?: boolean;
}

export interface FunctionToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn> {
  type: 'function';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  handler: ToolHandler<TIn, TOut>;
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

export interface HttpToolDef<TIn = unknown, TOut = unknown> extends ToolBase, ToolHostHooks<TIn> {
  type: 'http';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  endpoint: string; // URL template, e.g. "https://api.example.com/items/{id}"
  method: HttpMethod;
  headers?: Record<string, string>;
  auth?: HttpToolAuthConfig;
  mapping?: {
    pathParams?: string[];
    queryParams?: string[];
    bodyParam?: string;
  };
}

export interface McpToolDef<TIn = unknown, TOut = unknown> extends ToolBase, ToolHostHooks<TIn> {
  type: 'mcp';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  serverUrl: string; // HTTP MCP server endpoint URL
  mcpToolName: string; // Name of the tool on the remote MCP server
  headers?: Record<string, string>;
  auth?: HttpToolAuthConfig;
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
  /** Opaque application context from `TurnRequest.host`; the kernel never reads it. */
  host?: unknown;
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
   * Optional turn snapshot from a gated turn. Cloned before use so concurrent host
   * invokes do not share mutable visibility state.
   */
  snapshot?: TurnToolSnapshot;
  resume?: InvokeToolResume;
  sessionPermissions?: string[];
  /** Host credentials for authenticated HTTP / MCP tools keyed by auth slot. */
  credentials?: Record<string, ToolCredential>;
  path?: string;
  signal?: AbortSignal;
  /** Opaque application context handed to the tool as `ctx.host`; the kernel never reads it. */
  host?: unknown;
  /**
   * Optional stage handler for this invoke — `pre_tool` / `post_tool` only
   * (`docs/contracts/stages.md`).
   */
  onStage?: import('../stages.ts').StageHandler;
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
 * `builtInTools`) is wired at session setup regardless of `loadTier` —
 * declarations cannot be added mid-session, so on live every allowed tool is
 * effectively T0.
 */
export interface LiveProfileToolsSpec {
  /** Custom tools wired once at session setup (every load tier). */
  allow: ToolId[];
}

/**
 * Host profile tools — the explicit ceiling for host-driven `invokeTool` calls.
 * Every id in `allow` is executable with no visibility tiers and no path gating.
 */
export interface HostProfileToolsSpec {
  /** Custom function tools the host may invoke. */
  allow: ToolId[];
}

/**
 * What a tool body produced, before settlement projects, guards, and runs
 * `post_tool`. Every transport returns this; one settlement consumes it.
 */
export type ToolBodyOutcome =
  | { kind: 'ok'; outputRaw: unknown; modelResult: ModelToolResult }
  | { kind: 'gated'; gate: ToolGate }
  | { kind: 'aborted'; aborted: true | { reason?: string } }
  | {
      kind: 'failed';
      failure: ToolFailure;
      /** True when the body never ran. */
      callNotStarted: boolean;
    };

export interface ModelToolResult {
  finding: string;
  /** Lean JSON for model reasoning — must not carry media bytes. */
  data?: unknown;
  /**
   * Multimodal tool-result parts (text / image / audio / video / document).
   * Adapters wire these with the same fidelity as user input parts.
   */
  parts?: InteractionPart[];
  /**
   * Model-facing text, already fenced and redacted at the tool boundary.
   *
   * Set by `executeRegisteredTool`, which knows the tool's origin and the
   * profile's policy. `formatToolResult` prefers it; when it is absent — a host
   * formatting a recorded result outside the execution path — that function
   * guards the composed text itself under full detection.
   */
  modelText?: string;
  /** Where these bytes came from. Set alongside `modelText`. */
  provenance?: Provenance;
  /** Directive signals found in the content; raises the turn's taint. */
  suspicious?: GuardrailHit[];
}

export type ToolCallPhase =
  | 'running'
  | 'progress'
  | 'trace'
  | 'artifact'
  | 'warning'
  | 'complete'
  /**
   * @deprecated Shipping interactive/confirm pause. Target: `gate` for
   * confirm/permission/auth; awaiting is `complete` + awaiting payload.
   */
  | 'pause'
  /** pre_tool confirm / permission / auth — body did not run. */
  | 'gate'
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
  /** @deprecated Target: `gate` for confirm/permission/auth. */
  pause?: ToolPause;
  /** pre_tool gate — body did not run. */
  gate?: ToolGate;
  failure?: ToolFailure;
}
