import type { z } from 'zod';
import type { TurnDestinations } from '../../guardrails/destinations.ts';
import type { ResolveHost } from '../../guardrails/network.ts';
import type { GuardrailHit, Provenance, TurnTaint } from '../../guardrails/types.ts';
import type { ToolCredentialSource } from '../auth/credential-source.ts';
import type { OAuthEndpoints } from '../auth/types.ts';
import type {
  AuthUnauthenticatedPolicy,
  HttpMethod,
  ToolAccess,
  ToolAuthType,
  ToolLoadTier,
  ToolPermission,
  ToolResumeCause,
} from '../schema.ts';
import type {
  Source,
  ToolCallEdit,
  ToolCallEvent,
  ToolCallRequest,
  ToolFailure,
  ToolGate,
  ToolPhaseEvent,
  ToolTraceStep,
  ToolWarning,
  TurnToolSnapshot,
  WireFunctionTool,
} from '../turn-events.ts';
import type {
  InteractionPart,
  ModelId,
  ModelProvider,
  Profile,
  ProfileId,
  ToolId,
  TurnInput,
  TurnRequest,
  TurnTraceLink,
} from '../types.ts';
import type { UncheckedOutput } from './unchecked-output.ts';

export type {
  AuthUnauthenticatedPolicy,
  HttpMethod,
  ToolAccess,
  ToolAuthType,
  ToolCallEdit,
  ToolCallEvent,
  ToolCallRequest,
  ToolFailure,
  ToolGate,
  ToolPermission,
  ToolPhaseEvent,
  ToolTraceStep,
  ToolWarning,
  TurnToolSnapshot,
  WireFunctionTool,
};

export interface ToolLabels {
  activity?: string;
  activityPast?: string;
  request?: string;
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
}

/** How a held tool call resumes: approved, refused or retried after sign-in. */
export interface InvokeToolResume {
  /**
   * `true` skips the confirm / permission / `preTool` re-ask (an `edited` call runs `preTool` in full);
   * `false` settles as a refusal with no body; omitted is a first attempt or an auth retry.
   */
  granted?: boolean;
  /**
   * For `granted: false`: `declined` (default) fails as `declined`; `abandoned` and `expired`
   * as `cancelled`.
   */
  cause?: ToolResumeCause;
  /**
   * The gate answered was a sign-in. Granted, the model reads `sign_in.done` before the call's
   * result; refused, the `sign_in.*` note for its cause. Both name the tool's `auth.service`.
   */
  signIn?: boolean;
  /** The user edited the arguments before approving; `from` is the model's proposed input. */
  edited?: { from: Record<string, unknown> };
}

/**
 * What the page did for a call to a tool it answers: its `output`, or `timedOut` when the relay
 * stopped waiting for it.
 */
export type PageAnswer = { output: unknown; timedOut?: undefined } | { timedOut: true };

export interface ToolContext {
  profile: Profile;
  callId: string;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
  turn?: { step: number; taint?: TurnTaint; destinations?: TurnDestinations };
  resume?: InvokeToolResume;
  credentials?: ToolCredentialSource;
  resolveHost?: ResolveHost;
  /** Opaque application context from `TurnRequest.host` / `InvokeToolRequest.host`; the kernel never reads it. */
  host?: unknown;
  /** The page's answer to this call, for a tool with `answeredBy: 'page'`. */
  page?: PageAnswer;
  /** W3C `traceparent` of this call's `execute_tool` span; parent a tool's own outbound spans on it. */
  traceparent?: string;
  /** Set for a function tool with `auth` once its credential resolved: requests carrying it. */
  signedInFetch?: SignedInFetch;
}

/** A request body is text; the method defaults to GET. */
export type SignedInRequest = { method?: string; headers?: Record<string, string>; body?: string };

/**
 * A guarded fetch that carries the call's credential to the URL's own origin and
 * nowhere else (not across a redirect, not to a host the OAuth token was not issued
 * for). A response that refuses the credential (401, or 403 `insufficient_scope`)
 * throws; the kernel turns it into a new sign-in or `sign_in.out_of_scope`.
 */
export type SignedInFetch = (url: string | URL, request?: SignedInRequest) => Promise<Response>;

export type ToolStreamEvent<TOut = unknown> =
  | { kind: 'progress'; data: unknown }
  | { kind: 'trace'; step: ToolTraceStep }
  | { kind: 'artifact'; artifact: unknown }
  | { kind: 'warning'; warning: ToolWarning }
  | { kind: 'complete'; output: TOut };

export type SyncToolHandler<TIn, TOut> = (
  input: TIn,
  ctx: ToolContext,
) => TOut | UncheckedOutput | Promise<TOut | UncheckedOutput>;
export type StreamToolHandler<TIn, TOut> = (
  input: TIn,
  ctx: ToolContext,
) => AsyncGenerator<ToolStreamEvent<TOut>>;

export type ToolHandler<TIn, TOut> = SyncToolHandler<TIn, TOut> | StreamToolHandler<TIn, TOut>;

/**
 * `input` and `output` stay on each concrete tool so `TOut` is inferred from `output`, not
 * the handler's return type; moving them here silently breaks inference for stream handlers.
 */
export interface ToolHostHooks<TIn = unknown> {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** Runs before the host's `pre_tool` `onStage`. */
  preTool?: (
    input: TIn,
    ctx: ToolContext,
  ) =>
    | import('../stages.ts').StageResult
    | undefined
    | Promise<import('../stages.ts').StageResult | undefined>;
  exposeToModel?: boolean;
}

export interface ToolOutputHooks<TOut = unknown> {
  /** A source that fails `sourceSchema`, or a throw, is a `sources_invalid` warning and is not cited. */
  sources?: (output: TOut) => Source[];
}

export interface FunctionToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn>,
    ToolOutputHooks<TOut> {
  type: 'function';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  /** Returns `output`'s type, or `uncheckedOutput(value)` for a value it cannot type. */
  handler: ToolHandler<TIn, NoInfer<TOut>>;
  /**
   * `'page'`: the page the person is on answers the call, and the kernel supplies the handler.
   * `output` checks what the page sent.
   */
  answeredBy?: 'page';
  /**
   * The service the handler acts on for the person. The kernel resolves the slot
   * before the handler runs (gating, refreshing, or telling the model as the policy
   * says) and hands the handler `ctx.signedInFetch`; the handler never sees the credential.
   */
  auth?: ToolAuthConfig;
}

/** How a tool that acts for the person signs in to the service; http, mcp and function tools share it. */
export interface ToolAuthConfig {
  slot: string;
  type: ToolAuthType;
  /** The service the person signs in to, as they know it (e.g. "GitHub"); never blank. */
  service: string;
  headerName?: string;
  headerPrefix?: string;
  onUnauthenticated?: AuthUnauthenticatedPolicy;
  /** Named on the auth gate for the host's OAuth flow. */
  preResolved?: Partial<OAuthEndpoints & { resource: string }>;
  scopes?: string[];
  clientId?: string;
  redirectUri?: string;
}

export interface HttpToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn>,
    ToolOutputHooks<TOut> {
  type: 'http';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  endpoint: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  auth?: ToolAuthConfig;
  mapping?: {
    pathParams?: string[];
    queryParams?: string[];
    bodyParam?: string;
  };
}

export interface McpToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn>,
    ToolOutputHooks<TOut> {
  type: 'mcp';
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
  serverUrl: string;
  mcpToolName: string;
  headers?: Record<string, string>;
  auth?: ToolAuthConfig;
}

/** What the calling model sends an agent tool. */
export interface AgentToolInput {
  text: string;
}

/** What an agent tool returns: the called agent's reply. Media rides as `parts`. */
export interface AgentToolOutput {
  text: string;
  structured?: unknown;
  parts?: InteractionPart[];
}

/**
 * A tool whose call runs one turn of another registered agent. That agent is a
 * standalone profile; the tool is how another agent's model calls it. What the
 * call carries beyond the model's text is the host's choice (`onAgentCall`).
 */
export interface AgentToolDef extends ToolBase {
  type: 'agent';
  /** A text, image or speech profile, registered before this tool. Nothing it can call may gate. */
  profile: ProfileId;
  /** Calls to this tool in one turn of its caller. Omit: only `maxSteps` bounds them. */
  maxCallsPerTurn?: number;
  preTool?: ToolHostHooks<AgentToolInput>['preTool'];
  exposeToModel?: boolean;
}

export interface RegisteredAgentTool extends AgentToolDef, ToolHostHooks<AgentToolInput> {
  input: z.ZodType<AgentToolInput>;
  output: z.ZodType<AgentToolOutput>;
}

/** An agent tool call, as the host's `onAgentCall` sees it before the agent runs. */
export interface AgentCall {
  /** The agent tool's name. */
  tool: string;
  callId: string;
  /** The agent the tool runs. */
  profile: ProfileId;
  input: AgentToolInput;
  /** The agent whose model made the call. */
  caller: ProfileId;
  /** 1 for a call from the host's own turn; one more for each agent tool it came through. */
  depth: number;
  /** The outermost request's `metadata`. */
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * What the host sets on the called agent's turn. The kernel fixes its profile,
 * signal, trace parent and hook. `provider` runs the turn; omit it to use the
 * caller's, which works only when both are on the same provider and protocol.
 */
export interface AgentCallRequest
  extends Partial<
    Pick<TurnRequest, 'input' | 'effort' | 'metadata' | 'onStage' | 'conversationId'>
  > {
  model?: ModelId;
  provider?: ModelProvider;
}

/** Return nothing to run the agent on the model's text alone; `refuse` is read back to the model. */
export type AgentCallHook = (
  call: AgentCall,
) =>
  | AgentCallRequest
  | { refuse: string }
  | undefined
  | Promise<AgentCallRequest | { refuse: string } | undefined>;

/** A tool in a registry: builtin, function, HTTP, MCP or agent. */
export type RegisteredTool<TIn = unknown, TOut = unknown> =
  | BuiltinToolDef
  | FunctionToolDef<TIn, TOut>
  | HttpToolDef<TIn, TOut>
  | McpToolDef<TIn, TOut>
  | RegisteredAgentTool;

/** A function tool as registered: it has a `handler`, or the page answers it. */
export type FunctionToolInput<TIn = unknown, TOut = unknown> = Omit<
  FunctionToolDef<TIn, TOut>,
  'inputSchema' | 'outputSchema' | 'handler' | 'answeredBy'
> & {
  input: z.ZodType<TIn>;
  output: z.ZodType<TOut>;
} & (
    | { handler: ToolHandler<TIn, NoInfer<TOut>>; answeredBy?: 'page' }
    | { answeredBy: 'page'; handler?: undefined }
  );

export type ToolDefinitionInput<TIn = unknown, TOut = unknown> =
  | BuiltinToolDef
  | FunctionToolInput<TIn, TOut>
  | (Omit<HttpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType<TIn>;
      output: z.ZodType<TOut>;
    })
  | (Omit<McpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      input: z.ZodType<TIn>;
      output: z.ZodType<TOut>;
    })
  | AgentToolDef;

export interface PromoteLoadedResult {
  promoted: ToolId[];
  failure?: ToolFailure;
}

/** What a tool's loader is told: the profile, the input and the path. */
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

/** Picks which allowed T2 tools to load at turn start. */
export type ToolPolicy = (ctx: ToolLoadContext) => ToolId[] | Promise<ToolId[]>;

/** A request to run a held tool call outside a turn. */
export interface InvokeToolRequest {
  profile: string;
  name: string;
  /**
   * The model call this invoke resumes; its events join the call its turn already announced.
   * Absent for the host's own call, which gets a fresh id and is announced first.
   */
  callId?: string;
  input: unknown;
  /** Input for `profile.tools.t1Policy` selection. */
  turnInput?: TurnInput;
  /** T2 tools already promoted, e.g. restored from pause metadata; the host must have run the loader. */
  promoted?: ToolId[];
  /** Builtins resolve from this model. */
  model?: string;
  /** Cloned before use so concurrent invokes do not share mutable visibility state. */
  snapshot?: TurnToolSnapshot;
  resume?: InvokeToolResume;
  sessionPermissions?: string[];
  credentials?: ToolCredentialSource;
  resolveHost?: ResolveHost;
  path?: string;
  signal?: AbortSignal;
  /** Handed to the tool as `ctx.host`; the kernel never reads it. */
  host?: unknown;
  /** W3C `traceparent` of the host span this invoke runs under. */
  traceparent?: string;
  /** Recorded as `gen_ai.conversation.id`. */
  conversationId?: string;
  /** Preserved on the trace record; the kernel does not interpret it. */
  metadata?: Record<string, unknown>;
  links?: TurnTraceLink[];
  /** Receives `pre_tool` / `post_tool` only. */
  onStage?: import('../stages.ts').StageHandler;
  /** Runs an agent tool's turn; an agent tool needs it, or `onAgentCall` returning one. */
  provider?: ModelProvider;
  /** As `TurnRequest.onAgentCall`, for an agent tool this invoke runs. */
  onAgentCall?: AgentCallHook;
}

/** The tools a profile may use and how they load. */
export interface ProfileToolsSpec {
  /** Custom tools only; builtins live on `models.*.builtInTools`. */
  allow: ToolId[];
  /** Returns ids already allowed with `loadTier: 'T2'` to load at turn start. Not supported on `type: 'live'`. */
  t1Policy?: ToolPolicy;
  /** Must be in `allow`; completing with `{ loaded: string[] }` promotes those T2 ids. Not on `type: 'live'`. */
  t2Loader?: ToolId;
}

/** Live declarations cannot be added mid-session, so every allowed tool is wired at setup as if T0. */
export interface LiveProfileToolsSpec {
  allow: ToolId[];
}

/** Every id in `allow` is invokable with no visibility tiers and no path gating. */
export interface HostProfileToolsSpec {
  allow: ToolId[];
}

/** Every transport returns this; one settlement projects, guards and runs `post_tool`. */
export type ToolBodyOutcome =
  | { kind: 'ok'; outputRaw: unknown; modelResult: ModelToolResult }
  | { kind: 'gated'; gate: ToolGate }
  | { kind: 'aborted'; aborted: true | { reason?: string } }
  | {
      kind: 'failed';
      failure: ToolFailure;
      callNotStarted: boolean;
      /** The host refused the call (`deny`), rather than it failing. */
      denied?: true;
    };

export interface ModelToolResult {
  finding: string;
  /** Lean JSON for model reasoning — must not carry media bytes. */
  data?: unknown;
  /** Adapters wire these with the same fidelity as user input parts. */
  parts?: InteractionPart[];
  /**
   * Already fenced and redacted by `executeRegisteredTool`. When absent (a recorded result
   * formatted outside execution), `formatToolResult` guards the text itself under full detection.
   */
  modelText?: string;
  provenance?: Provenance;
  /** Directive signals found in the content; raises the turn's taint. */
  suspicious?: GuardrailHit[];
}
