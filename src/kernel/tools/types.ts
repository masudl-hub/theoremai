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
  ToolGateKind,
  ToolLoadTier,
  ToolPermission,
  ToolResumeCause,
} from '../schema.ts';
import type {
  RemovedItem,
  Source,
  ToolCallEdit,
  ToolCallEvent,
  ToolCallRequest,
  ToolFailure,
  ToolGate,
  ToolOutputPart,
  ToolOutputRefPart,
  ToolPhaseEvent,
  ToolTraceStep,
  ToolWarning,
  TurnToolSnapshot,
  WireFunctionTool,
} from '../turn-events.ts';
import type {
  InteractionPart,
  ModelId,
  Profile,
  ProfileId,
  RunControls,
  ToolId,
  TurnInput,
  TurnRequest,
  TurnSpeech,
} from '../types.ts';
import type { LabelTemplate } from './activity-label.ts';
import type { ToolBackground, ToolBackgroundService } from './background.ts';
import type { PageToolExecution, ToolExecutionCoordinator } from './operation.ts';
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
  /**
   * Transcript text while a call runs, e.g. 'Saving {title} to your collection'. {path} reads the
   * call's input.
   */
  activity?: LabelTemplate;
  /**
   * What the transcript says once a call completes, e.g. 'Found {results.0.name}'. Each {path} is
   * filled from the call's input, then its output.
   */
  activityPast?: LabelTemplate;
  /**
   * What the transcript says when a call fails or the host labels it failed, e.g. 'Couldn't save
   * {title}'. Each {path} is filled from the call's input.
   */
  activityFailed?: LabelTemplate;
  /**
   * What the approval card says the agent wants to do, e.g. 'check the weather in {city}'. Each
   * {path} is filled from the call's input.
   */
  request?: LabelTemplate;
}

export interface ToolBase {
  /**
   * The tool's id, which profiles list in tools.allow (or a model's builtInTools) and the model
   * calls a custom tool by.
   */
  name: string;
  /** Tells the model what the tool does (custom tools only). */
  description: string;
  /** A label for grouping tools; nothing reads it yet. */
  category: string;
  /**
   * What the tool can change, which taint.afterRemoteRead refuses calls by after a turn reads a
   * remote tool's result.
   */
  access: ToolAccess;
  /**
   * The turn paths this tool is offered on, where * means every path; a turn with no path gets only
   * * tools. Host profiles ignore it.
   */
  paths: string[];
  /**
   * When the tool becomes available to the model; live and host profiles load every allowed tool at
   * the start.
   */
  loadTier: ToolLoadTier;
  /** Whether the host must approve a call before it runs; the provider's own tools never ask. */
  permission: ToolPermission;
  /**
   * Transcript text for a call. {path} reads a value from the call. {results.0.name} reads a list
   * item. {path|text} shows the text when the value is unusable. {count hit|hits} shows a number
   * with the word for one or for any other number: '1 hit', '3 hits'. With no fallback, the label
   * is dropped. A label is one line, or a list read top to bottom: the first line that fits is
   * shown. A line fits when each {path} has a value and its condition holds, as in 'when status is
   * archived: archiving {title}'. Neighbouring lines that open with '+ ' show together, joined in
   * words. The last line of a list must always fit.
   */
  labels?: ToolLabels;
}

/**
 * A tool the provider runs. This is its entry in the tool list; the provider's
 * adapter declares it (`ProviderAdapter.builtins`) and owns how it is sent.
 */
export interface BuiltinToolDef extends ToolBase {
  /** How the tool runs. */
  type: 'builtin';
  /** The built-in tools a builtin tool cannot run beside. */
  conflictsWith?: string[];
}

/** How a held tool call resumes: approved, refused, or retried after sign-in. */
export interface InvokeToolResume {
  gateKind?: ToolGateKind;
  /**
   * `true` approves this call. An unchanged confirmation skips the tool's completed `preTool` check.
   * Permission and auth gates run `preTool` on resumption; edited arguments run it again.
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
 * What the page did for a call to a tool it answers: its `output`, `timedOut` when the relay
 * stopped waiting for it, or `unanswered` when the page has nothing that answers the tool.
 */
export type PageAnswer =
  | { output: unknown; timedOut?: undefined; unanswered?: undefined }
  | { timedOut: true; unanswered?: undefined }
  | { unanswered: true; timedOut?: undefined };

export interface ToolContext {
  profile: Profile;
  callId: string;
  readonly operationId: string;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
  /**
   * The turn as it stood when the step began. `visible`: the tools a call in this step may use;
   * a tool loaded during the step is callable from the next one.
   */
  turn?: {
    step: number;
    taint?: TurnTaint;
    destinations?: TurnDestinations;
    visible?: readonly ToolId[];
  };
  resume?: InvokeToolResume;
  credentials?: ToolCredentialSource;
  resolveHost?: ResolveHost;
  /** Sends this call's requests once their checks pass; the run's `fetch`. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Opaque application context from `TurnRequest.host` / `InvokeToolRequest.host`; the kernel never reads it. */
  host?: unknown;
  /** The page's answer to this call, for a tool with `answeredBy: 'page'`. */
  page?: PageAnswer;
  pageExecution?: PageToolExecution;
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
  /**
   * The next piece of what the tool is writing, for the host to preview. Each is read at the
   * tool's `tool_output` boundary first; the model never reads it, only `complete`'s output.
   */
  | { kind: 'draft'; text: string }
  | { kind: 'trace'; step: ToolTraceStep }
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
  /**
   * The tool's arguments as a JSON Schema, sent to the model.
   */
  inputSchema: Record<string, unknown>;
  /**
   * The tool's result as a JSON Schema, which a function tool's stand-in result is built from.
   */
  outputSchema: Record<string, unknown>;
  /**
   * Runs before the host's pre_tool onStage. A throw fails the call, reported as hook_failed.
   *
   * @remarks Runs before the host's `pre_tool` `onStage`.
   */
  preTool?: (
    input: TIn,
    ctx: ToolContext,
  ) =>
    | import('../stages.ts').StageResult
    | undefined
    | Promise<import('../stages.ts').StageResult | undefined>;
  /** Whether the model can see and call the tool. */
  exposeToModel?: boolean;
  /**
   * Gives the model an after field on this tool: the tools called in the same step that must settle
   * before this call starts. The kernel removes the field before the tool, the stages or a gate
   * read the input. A name with no other call in the step fails the call wait_unknown.
   *
   * @remarks The model gets an `after` field: the tools in the same step that must settle before
   * this call starts.
   */
  after?: boolean;
  /**
   * When the model gets its reply while the body goes on. 'always': at the hand-off. { afterMs }:
   * once the body has run past this time. 'ask': at the hand-off if the model sets the background
   * argument. A turn with no background service runs the tool inline.
   *
   * @remarks When the model gets its reply. Unset is `never`: when the body ends. A turn without a
   * background service runs inline.
   */
  background?: ToolBackground;
  /** `inputSchema` with the `background` argument. The registry sets it on an `ask` tool. */
  askInputSchema?: Record<string, unknown>;
}

export interface ToolOutputHooks<TOut = unknown> {
  /**
   * The sources a result cites. One that fails sourceSchema, or a throw, is a sources_invalid
   * warning and is not cited.
   *
   * @remarks A source that fails `sourceSchema`, or a throw, is a `sources_invalid` warning and is
   * not cited.
   */
  sources?: (output: TOut) => Source[];
}

/**
 * One piece of media a tool's `media(output)` names. `{ url }` is a picture the kernel fetches for
 * the model to look at, also shown to the person with `sent: true`. `{ type, mimeType, uri }` is a
 * reference the person is shown through the app's own resolver; the model never reads it.
 */
export type ToolMediaEntry = { url: string; sent?: true } | ToolOutputRefPart;

/** For a tool whose response the builder does not write; a function tool returns its media itself as `parts`. */
export interface ToolMediaHooks<TOut = unknown> {
  /**
   * The media in the output: pictures the model should see, and references the person is shown.
   *
   * @remarks A `{ url }` entry is an https address of a picture the model should see. After the
   * result passes the output guard, the kernel fetches it through the profile's network policy,
   * without the tool's credentials, and hands the model the image as a part; one it cannot fetch is
   * an `images_unfetched` warning, never a failed call. `sent: true` also shows it to the person. A
   * `{ type, mimeType, uri }` entry is a reference: the person is shown it through the app's own
   * resolver, and the model never reads it.
   */
  media?: (output: TOut) => ToolMediaEntry[];
  /**
   * How many of the pictures `media` names the kernel fetches, how large, and how slowly.
   *
   * @remarks How many of the pictures `media` names the kernel fetches, how large, and how
   * slowly. Left out, there is no limit. References are not fetched, so they are not counted.
   */
  imageLimits?: ToolImageLimits;
}

/** Each limit left out is no limit. A picture past one is left out, not cut. */
export interface ToolImageLimits {
  /** The most pictures one call hands the model; the first ones named are kept. */
  count?: number;
  /** The largest picture fetched. */
  bytes?: number;
  /** The most one call hands the model in all. */
  totalBytes?: number;
  /** How long each picture may take. */
  timeoutMs?: number;
}

export interface FunctionToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn>,
    ToolOutputHooks<TOut> {
  /** How the tool runs. */
  type: 'function';
  /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
  input: z.ZodType<TIn>;
  /**
   * The Zod schema every result the tool returns must match; the kernel's own not-signed-in note is
   * not checked.
   */
  output: z.ZodType<TOut>;
  /**
   * Your function that runs the tool; it can also yield progress as it goes.
   *
   * @remarks Returns `output`'s type, or `uncheckedOutput(value)` for a value it cannot type.
   */
  handler: ToolHandler<TIn, NoInfer<TOut>>;
  /**
   * Who answers a call to a function tool. With page, the page the agent is on returns the
   * output, and the tool has no handler.
   *
   * @remarks `'page'`: the page the person is on answers the call, and the kernel supplies the
   * handler. `output` checks what the page sent.
   */
  answeredBy?: 'page';
  /**
   * How the tool gets its credential.
   *
   * @remarks The service the handler acts on for the person. The kernel resolves the slot before
   * the handler runs (gating, refreshing, or telling the model as the policy says) and hands the
   * handler `ctx.signedInFetch`; the handler never sees the credential.
   */
  auth?: ToolAuthConfig;
}

/** How a tool that acts for the person signs in to the service; http, mcp, and function tools share it. */
export interface ToolAuthConfig {
  /** Which of the credentials the turn passes in this tool uses. */
  slot: string;
  /**
   * The kind of credential the tool expects, shown when a turn stops to ask for one; the header
   * follows the stored credential's own kind.
   */
  type: ToolAuthType;
  /**
   * The service the person signs in to, as they know it, named when a turn stops to ask for a
   * credential.
   *
   * @remarks The service the person signs in to, as they know it (e.g. "GitHub"); never blank.
   */
  service: string;
  /** The header the credential goes in; an API key's own headerName comes first. */
  headerName?: string;
  /** Text put before the credential in the header; an API key's own headerPrefix comes first. */
  headerPrefix?: string;
  /**
   * For a service that takes its API key in the URL: the query parameter the key goes in, in place
   * of a header.
   *
   * @remarks For a service that takes its API key in the URL (`?key=…`): the query parameter the
   * key goes in, in place of a header. Only an `api_key` tool sets it, with no `headerName` or
   * `headerPrefix`.
   */
  queryParam?: string;
  /**
   * What happens when the credential is missing, expired, can't be refreshed or is refused by the
   * service.
   */
  onUnauthenticated?: AuthUnauthenticatedPolicy;
  /**
   * Named on the auth gate for the host's OAuth flow, so it need not find them.
   *
   * @remarks Named on the auth gate for the host's OAuth flow.
   */
  preResolved?: Partial<OAuthEndpoints & { resource: string }>;
  /**
   * The OAuth scopes the tool needs, shown when a turn stops to ask for a credential. A service
   * asking for any other scope fails the call, with no new sign-in.
   */
  scopes?: string[];
  /** Your OAuth client id, kept for the host's sign-in flow; the kernel doesn't read it. */
  clientId?: string;
  /** Your OAuth redirect URI, kept for the host's sign-in flow; the kernel doesn't read it. */
  redirectUri?: string;
}

export interface HttpToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn>,
    ToolOutputHooks<TOut>,
    ToolMediaHooks<TOut> {
  /** How the tool runs. */
  type: 'http';
  /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
  input: z.ZodType<TIn>;
  /**
   * The Zod schema every result the tool returns must match; the kernel's own not-signed-in note is
   * not checked.
   */
  output: z.ZodType<TOut>;
  /**
   * The URL the tool calls, with {name} placeholders for mapping.pathParams; the scheme and host
   * must be written out.
   */
  endpoint: string;
  /** The HTTP method; every method but GET sends a JSON body. */
  method: HttpMethod;
  /** Headers sent with every request to the tool's own origin, never once a redirect leaves it. */
  headers?: Record<string, string>;
  /** How the tool gets its credential. */
  auth?: ToolAuthConfig;
  /** Where each argument goes in the request. */
  mapping?: {
    /** Arguments that fill the {name} placeholders in the endpoint. */
    pathParams?: string[];
    /** Arguments added to the query string. */
    queryParams?: string[];
    /**
     * The one argument sent as the whole JSON body; without it, a method other than GET sends every
     * argument the path and query leave unused.
     */
    bodyParam?: string;
  };
  /** The service's own limit for one key; the kernel keeps this tool's requests within it. */
  limit?: HttpToolLimit;
  /**
   * The most bytes of a response body an HTTP or MCP tool reads; past it the call fails with
   * response_too_large.
   *
   * @remarks The most of a response body the kernel reads; past it the call fails
   * `response_too_large`. Left out, there is no limit.
   */
  maxResponseBytes?: number;
  /**
   * How long the service may take to answer, its body read included. Past it the call fails timeout
   * and frees its place in the limit.
   *
   * @remarks How long the service may take to answer, its body read included. Past it the call
   * fails `timeout` and frees its place in the limit. Left out, a call waits as long as the
   * caller's signal lets it.
   */
  timeoutMs?: number;
}

/** The most requests a service takes from one key in a window. */
export interface HttpToolLimit {
  requests: number;
  windowMs: number;
}

export interface McpToolDef<TIn = unknown, TOut = unknown>
  extends ToolBase,
    ToolHostHooks<TIn>,
    ToolOutputHooks<TOut>,
    ToolMediaHooks<TOut> {
  /** How the tool runs. */
  type: 'mcp';
  /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
  input: z.ZodType<TIn>;
  /**
   * The Zod schema every result the tool returns must match; the kernel's own not-signed-in note is
   * not checked.
   */
  output: z.ZodType<TOut>;
  /** The MCP server's URL. */
  serverUrl: string;
  /** The tool's name on the MCP server. */
  mcpToolName: string;
  /** Headers sent with every request to the tool's own origin, never once a redirect leaves it. */
  headers?: Record<string, string>;
  /** How the tool gets its credential. */
  auth?: ToolAuthConfig;
  /**
   * The most bytes of a response body an HTTP or MCP tool reads; past it the call fails with
   * response_too_large.
   *
   * @remarks The most of a response body the kernel reads; past it the call fails
   * `response_too_large`. Left out, there is no limit.
   */
  maxResponseBytes?: number;
  /**
   * How long and how many of an MCP tool's server sessions the kernel keeps.
   *
   * @remarks How long and how many of this tool's server sessions the kernel keeps. Left out, there
   * is no limit.
   */
  session?: McpSessionLimits;
}

/** The sessions an MCP tool keeps: each field left out is no limit. */
export interface McpSessionLimits {
  /** How long a session may sit unused before the next call opens a new one, in milliseconds. */
  idleMs?: number;
  /** The most sessions the tool keeps open; past it the least recently used is dropped. */
  max?: number;
}

/**
 * What an agent tool call carries: the text, and whatever else the called
 * profile's `inputs` declares. `speech` is for a speech profile.
 */
export interface AgentToolInput extends Pick<TurnInput, 'options' | 'attachments' | 'voice'> {
  text: string;
  speech?: TurnSpeech;
}

/** What an agent tool returns: the called agent's reply. Media rides as `parts`, citations as `sources`. */
export interface AgentToolOutput {
  /** The reply's text; absent when the reply is `structured`, whose text is the same JSON. */
  text?: string;
  structured?: unknown;
  /** Items the called profile's item rules removed from `structured`, each with why. */
  removed?: RemovedItem[];
  /** The media the called agent made, each `sent`: the person is shown it, as a top-level agent's own. */
  parts?: ToolOutputPart[];
  /** What the called agent cited; the caller's turn cites them too. */
  sources?: Source[];
}

/** A channel of an agent tool's input: one the called profile's `inputs` declares, or `speech` on a speech profile. */
export type AgentToolChannel = 'attachments' | 'voice' | 'options' | 'speech';

/**
 * A tool whose call runs one turn of another registered agent. That agent is a
 * standalone profile; the tool is how another agent's model calls it. Its input
 * is what that profile's `inputs` declares; the host can reshape a call (`onAgentCall`).
 */
export interface AgentToolDef extends ToolBase {
  /** How the tool runs. */
  type: 'agent';
  /**
   * The profile this agent tool runs: text, image, or speech. Register it first. Nothing it calls
   * may stop on a gate.
   *
   * @remarks A text, image, or speech profile, registered before this tool. Nothing it can call may
   * gate.
   */
  profile: ProfileId;
  /**
   * How many times one turn of the calling agent may run this tool.
   *
   * @remarks Calls to this tool in one turn of its caller. Omit: only `maxSteps` bounds them.
   */
  maxCallsPerTurn?: number;
  /**
   * What the calling model reads on a field of an agent tool input, such as text. A field the
   * profile does not take is refused when the tool registers.
   *
   * @remarks What the calling model reads on a field of the tool's input, by field. A field the
   * profile does not take is refused.
   */
  fieldText?: Partial<Record<keyof AgentToolInput, string>>;
  /**
   * Fields on an agent tool that only the host reads. The calling model fills them, or the host
   * does when a field is marked exposeToModel: false. onAgentCall gets them as hostInput and turns
   * them into what the agent is sent; the agent never sees them. A name the input already has is
   * refused when the tool registers.
   *
   * @remarks Fields only the host reads. The calling model fills them, or the host when a field is
   * marked `exposeToModel: false`. `onAgentCall` gets them as `hostInput` and turns them into the
   * agent's input; they are never sent to the agent. A name the input already has is refused, and a
   * call without the hook is a config error.
   */
  hostFields?: Record<string, z.ZodType>;
  /**
   * Channels the called profile takes that the calling model cannot fill on an agent tool; only
   * onAgentCall sends them. A channel the profile does not take is refused when the tool registers.
   *
   * @remarks Channels the profile takes that the calling model can't fill; only `onAgentCall` sends
   * them.
   */
  hostOnly?: AgentToolChannel[];
  /** Runs before the host's pre_tool onStage. A throw fails the call, reported as hook_failed. */
  preTool?: ToolHostHooks<AgentToolInput>['preTool'];
  /**
   * Gives the model an after field on this tool: the tools called in the same step that must settle
   * before this call starts. The kernel removes the field before the tool, the stages or a gate
   * read the input. A name with no other call in the step fails the call wait_unknown.
   */
  after?: ToolHostHooks<AgentToolInput>['after'];
  /**
   * When the model gets its reply while the body goes on. 'always': at the hand-off. { afterMs }:
   * once the body has run past this time. 'ask': at the hand-off if the model sets the background
   * argument. A turn with no background service runs the tool inline.
   */
  background?: ToolHostHooks<AgentToolInput>['background'];
  /** Whether the model can see and call the tool. */
  exposeToModel?: boolean;
}

export interface RegisteredAgentTool
  extends AgentToolDef,
    ToolHostHooks<AgentToolInput>,
    ToolOutputHooks<AgentToolOutput> {
  /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
  input: z.ZodType<AgentToolInput>;
  /**
   * The Zod schema every result the tool returns must match; the kernel's own not-signed-in note is
   * not checked.
   */
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
  /** What the model sent in the tool's `hostFields`; absent when the tool declares none. */
  hostInput?: Record<string, unknown>;
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
 * signal, trace parent, and hook. `provider` runs the turn; omit it to use the
 * caller's, which works only when both are on the same provider and protocol.
 * `host` is what the called agent's tools read as `ctx.host`; omit it and they
 * read none, because the caller's is not passed down. `path` is the path the
 * called agent's turn runs on; omit it and its turn has none, so it gets only
 * tools on every path (`'*'`). `options` fills the called profile's own
 * `identity.options`, for its `when` lines; the caller's are not passed down.
 */
export interface AgentCallRequest
  extends Partial<
    Pick<
      TurnRequest,
      | 'input'
      | 'speech'
      | 'effort'
      | 'builtInArgs'
      | 'metadata'
      | 'onStage'
      | 'conversationId'
      | 'host'
      | 'path'
      | 'options'
    >
  > {
  model?: ModelId;
  provider?: import('../protocols/runtime.ts').ProviderHostOptions;
}

/** Return nothing to run the agent on what the model sent; `refuse` is read back to the model. */
export type AgentCallHook = (
  call: AgentCall,
) =>
  | AgentCallRequest
  | { refuse: string }
  | undefined
  | Promise<AgentCallRequest | { refuse: string } | undefined>;

/** A tool in a registry: builtin, function, HTTP, MCP, or agent. */
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
  /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
  input: z.ZodType<TIn>;
  /**
   * The Zod schema every result the tool returns must match; the kernel's own not-signed-in note is
   * not checked.
   */
  output: z.ZodType<TOut>;
} & (
    | {
        /** Your function that runs the tool; it can also yield progress as it goes. */
        handler: ToolHandler<TIn, NoInfer<TOut>>;
        /**
         * Who answers a call to a function tool. With page, the page the agent is on returns the
         * output, and the tool has no handler.
         */
        answeredBy?: 'page';
      }
    | {
        /**
         * Who answers a call to a function tool. With page, the page the agent is on returns the
         * output, and the tool has no handler.
         */
        answeredBy: 'page';
        /** Your function that runs the tool; it can also yield progress as it goes. */
        handler?: undefined;
      }
  );

export type ToolDefinitionInput<TIn = unknown, TOut = unknown> =
  | BuiltinToolDef
  | FunctionToolInput<TIn, TOut>
  | (Omit<HttpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
      input: z.ZodType<TIn>;
      /**
       * The Zod schema every result the tool returns must match; the kernel's own not-signed-in
       * note is not checked.
       */
      output: z.ZodType<TOut>;
    })
  | (Omit<McpToolDef<TIn, TOut>, 'inputSchema' | 'outputSchema'> & {
      /** The Zod schema for the tool's arguments, sent to the model and checked on every call. */
      input: z.ZodType<TIn>;
      /**
       * The Zod schema every result the tool returns must match; the kernel's own not-signed-in
       * note is not checked.
       */
      output: z.ZodType<TOut>;
    })
  | AgentToolDef;

export interface PromoteLoadedResult {
  promoted: ToolId[];
  failure?: ToolFailure;
}

/** What a tool's loader is told: the profile, the input, and the path. */
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
export interface InvokeToolRequest extends RunControls {
  execution?: ToolExecutionCoordinator;
  background?: ToolBackgroundService;
  /** invariant: Only the trusted host restores the kernel-issued identity from saved authority. */
  operationId?: string;
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
  /** Sends the call's requests once their checks pass. Default: the global `fetch`. */
  fetch?: typeof fetch;
  path?: string;
  /** Handed to the tool as `ctx.host`; the kernel never reads it. */
  host?: unknown;
  /** The page's answer, when this invoke answers a `page` gate. */
  page?: PageAnswer;
  pageExecution?: PageToolExecution;
  /** Receives `pre_tool` / `post_tool` only. */
  onStage?: import('../stages.ts').StageHandler;
  /** Runs an agent tool's turn; an agent tool needs it, or `onAgentCall` returning one. */
  provider?: import('../protocols/runtime.ts').ProviderHostOptions;
  /** As `TurnRequest.onAgentCall`, for an agent tool this invoke runs. */
  onAgentCall?: AgentCallHook;
}

/** One of the host's calls in a step. */
export interface InvokeToolStepCall {
  name: string;
  /**
   * The model's call this runs, already announced by its turn; absent for the host's own
   * call, which gets a fresh id and is announced by the step.
   */
  callId?: string;
  /** invariant: Only the trusted host restores the kernel-issued identity from saved authority. */
  operationId?: string;
  input: unknown;
}

/**
 * A request to run several calls outside a turn, as one step. Everything but the calls is
 * shared by all of them. A call that answers an approval or a page resumes on its own,
 * through `InvokeToolRequest`.
 */
export interface InvokeToolStepRequest
  extends Omit<InvokeToolRequest, 'name' | 'callId' | 'operationId' | 'input' | 'resume' | 'page'> {
  calls: InvokeToolStepCall[];
}

/** The tools a profile may use and how they load. */
export interface ProfileToolsSpec {
  /**
   * Your registered tools this agent may use; the provider's own tools go on the model's
   * builtInTools instead.
   *
   * @remarks Custom tools only; builtins live on `models.*.builtInTools`.
   */
  allow: ToolId[];
  /**
   * Your function that picks, at the start of each turn, which T2 tools to load up front; the rest
   * wait for tools.t2Loader. A throw loads none up front, reported as hook_failed.
   *
   * @remarks Returns ids already allowed with `loadTier: 'T2'` to load at turn start. Not supported
   * on `type: 'live'`.
   */
  t1Policy?: ToolPolicy;
  /**
   * The function tool that loads T2 tools. It must be in allow and return { loaded: ToolId[] }. One
   * forbidden id fails the load. Ids off the turn path are skipped. The tools it loads can be
   * called from the next step: a step's calls see the tools as they stood when the step began.
   *
   * @remarks Must be in `allow`; completing with `{ loaded: string[] }` promotes those T2 ids. Not
   * on `type: 'live'`. The tools it loads can be called from the next step.
   */
  t2Loader?: ToolId;
  /**
   * true: the calls of one step run side by side, and a call whose pre_tool answers waitFor starts
   * its body once those calls settle. Left out or false: they run one at a time, in the order the
   * model made them. A step is the calls the model makes together in a turn, or the calls a host
   * runs through invokeToolStep.
   *
   * @remarks `true`: a step's calls run side by side, each body starting once the calls its
   * `pre_tool` `waitFor` names have settled. Left out or `false`: one at a time, in the order the
   * model made them.
   */
  parallel?: boolean;
}

/** Live declarations cannot be added mid-session, so every allowed tool is wired at setup as if T0. */
export interface LiveProfileToolsSpec {
  /**
   * Your registered tools this agent may use; the provider's own tools go on the model's
   * builtInTools instead.
   */
  allow: ToolId[];
  /**
   * true: the calls of one step run side by side, and a call whose pre_tool answers waitFor starts
   * its body once those calls settle. Left out or false: they run one at a time, in the order the
   * model made them. A step is the calls the model makes together in a turn, or the calls a host
   * runs through invokeToolStep.
   *
   * @remarks `true`: the calls of one model message, run as a step through `invokeToolStep`, run
   * side by side, each body starting once the calls its `pre_tool` `waitFor` names have settled.
   * Left out or `false`: one at a time, in the order the model made them.
   */
  parallel?: boolean;
}

/** Every id in `allow` is invokable with no visibility tiers and no path gating. */
export interface HostProfileToolsSpec {
  /**
   * Your registered tools this agent may use; the provider's own tools go on the model's
   * builtInTools instead.
   */
  allow: ToolId[];
  /**
   * true: the calls of one step run side by side, and a call whose pre_tool answers waitFor starts
   * its body once those calls settle. Left out or false: they run one at a time, in the order the
   * model made them. A step is the calls the model makes together in a turn, or the calls a host
   * runs through invokeToolStep.
   *
   * @remarks `true`: the calls of one `invokeToolStep` run side by side, each body starting once
   * the calls its `pre_tool` `waitFor` names have settled. Left out or `false`: one at a time, in
   * the order given.
   */
  parallel?: boolean;
}

/** Every transport returns this; one settlement projects, guards, and runs `post_tool`. */
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
  /** What the model reads beside the text, derived from `media` by `readParts`. Adapters wire these with the same fidelity as user input parts. */
  parts?: InteractionPart[];
  /** What the tool returned beside its output, as the person may be shown it: `sent` media and references. */
  media?: ToolOutputPart[];
  /** The tool is hidden (`exposeToModel: false`): the model read none of its output, `media` included. */
  hidden?: true;
  /**
   * Already fenced and redacted by `executeRegisteredTool`. When absent (a recorded result
   * formatted outside execution), `formatToolResult` guards the text itself under full detection.
   */
  modelText?: string;
  provenance?: Provenance;
  /** Directive signals found in the content; raises the turn's taint. */
  suspicious?: GuardrailHit[];
}
