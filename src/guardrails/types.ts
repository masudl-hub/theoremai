/**
 * Guardrail vocabulary — trust levels, stages, verdicts, and profile policy shape.
 *
 * This module is the single source of truth for guardrail types. It must not import
 * from `src/kernel/`: the kernel type-imports `ProfileGuardrailsSpec` for
 * `ProfileCommon.guardrails`, and that edge stays one-directional. Implementation
 * modules under `src/guardrails/` may import kernel types freely.
 *
 * @module
 */

import type { LexiconOverrides } from './lexicon.ts';

/**
 * Origin trust for text entering the model's context.
 *
 * - `trusted` — author-time profile text (`identity.system`). Sensitive redaction
 *   only; injection redaction would mangle the host's own instructions.
 * - `assembled` — host-built per turn (`req.system`). Interpolates retrieval and
 *   user data, so it is permeable and takes full detection.
 * - `untrusted` — user input, tool results, attachments, delegated agents.
 */
export const TRUST_LEVELS = ['trusted', 'assembled', 'untrusted'] as const;
/** Origin trust classification for text entering a model context. */
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Boundary a guardrail check runs at. */
export const GUARDRAIL_STAGES = [
  'input',
  'history',
  'system',
  'attachment',
  'tool_call',
  'tool_result',
  'output_delta',
  'output_final',
  'network',
  'live_inbound',
  'live_outbound',
  'trace',
] as const;
/** A boundary at which a guardrail check can run. */
export type GuardrailStage = (typeof GUARDRAIL_STAGES)[number];

/** How serious a hit is. Does not decide what happens next — that is `onBlock`. */
export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
/** Severity assigned to a guardrail finding. */
export type Severity = (typeof SEVERITIES)[number];

/** Egress block handling. */
export const EGRESS_ON_BLOCK = ['reject_to_agent', 'refuse_to_user'] as const;
/** The action to take when an egress guardrail blocks output. */
export type EgressOnBlock = (typeof EGRESS_ON_BLOCK)[number];

/** One detector match. */
export interface GuardrailHit {
  /** Stable rule id, e.g. `injection.instruction-override`. */
  rule: string;
  severity: Severity;
  /** Offsets into the inspected text; absent for whole-payload checks. */
  span?: { start: number; end: number };
  /**
   * Exact matched substring (capped). Present when detectors had the source text.
   * Stripped from host/trace unless `observability.include.guardrailMatchPreview`.
   */
  match?: string;
}

/**
 * Outcome of one guardrail evaluation.
 *
 * A discriminated union so a new variant fails every unhandled `switch` at
 * compile time rather than falling through at runtime.
 */
export type Verdict =
  | { action: 'allow' }
  | { action: 'redact'; text: string; hits: GuardrailHit[] }
  | { action: 'flag'; hits: GuardrailHit[] }
  | {
      action: 'block';
      hits: GuardrailHit[];
      /**
       * Sent to the model on a repair turn when `onBlock` is `reject_to_agent`.
       * With `refuse_to_user` the user reads the lexicon's `egress.refusal`.
       */
      rejection: string;
      /**
       * Why the check blocked, for the builder only: it reaches the host and the
       * trace (content-gated), never the model or a client (`forClient`).
       */
      errorInternal?: string;
    };

/** The action selected by a guardrail verdict. */
export type GuardrailAction = Verdict['action'];

/**
 * Where a tool result came from.
 *
 * `local` is host TypeScript the profile registered; `http` and `mcp` are remote
 * services whose bytes the host does not control. `delegated` is another agent
 * answering through the tool boundary — its output is model-generated prose that
 * reads as authoritative, which is why depth is tracked separately.
 */
export const TOOL_ORIGINS = ['local', 'builtin', 'http', 'mcp', 'delegated'] as const;
/** Source category for a registered tool result. */
export type ToolOrigin = (typeof TOOL_ORIGINS)[number];

/** Where a piece of content entered the turn from. */
export interface Provenance {
  origin: ToolOrigin;
  /** Registered tool name. */
  tool: string;
  /**
   * Hops from the user's turn. A direct tool call is 1; a tool result produced by
   * a delegated agent that itself called tools is deeper. Depth matters because a
   * two-hop delegation can otherwise launder remote content into trusted-looking
   * output.
   */
  depth: number;
}

/**
 * Untrusted content a turn has already taken into its context.
 *
 * Once a turn has read attacker-influenceable bytes, a later tool call is a
 * confused-deputy risk: the content can ask the agent to act, and the agent has
 * authority the content does not. Sources are kept in order so a policy can reason
 * about depth as well as presence.
 */
export interface TurnTaint {
  sources: Provenance[];
  /**
   * Directive hits found in remote content this turn read.
   *
   * Separates "read something remote" from "read something that tried to steer
   * me". The second is far rarer, so a gate keyed on it refuses far less
   * legitimate work.
   */
  suspicious: GuardrailHit[];
}

/**
 * What a turn may still do after it has ingested untrusted remote content.
 *
 * Enforcement is opt-in. Tracking and reporting are on by default — every
 * remote read is observable — but refusing tool calls changes what working agents
 * are allowed to do, so a host declares which access levels to gate rather than
 * having the kernel guess.
 */
/**
 * How strongly the tool-ingress signals fired, derived from the hits themselves.
 *
 * Not a probability: there is no calibrated model behind it. `elevated` means one
 * directive signal alongside an external destination; `high` means the content
 * named a tool the model can call, or several signals agreed.
 */
export const ADVISORY_LEVELS = ['none', 'elevated', 'high'] as const;
/** Strength of advisory tool-ingress signals. */
export type AdvisoryLevel = (typeof ADVISORY_LEVELS)[number];

/** Ordered taint-gate values from reporting only through write-capability refusal. */
export const TAINT_GATES = ['off', 'destructive', 'write'] as const;
/** Least-severe tool capability refused after untrusted content is read. */
export type TaintGate = (typeof TAINT_GATES)[number];

/**
 * Only structural facts gate tool calls.
 *
 * Content signals from `tool-directives.ts` deliberately have no gate here. They
 * are pattern matches with no measured precision, and refusing a tool call on an
 * unpredictable signal makes an agent unreliable rather than safe — the failure is
 * invisible to the user and looks like the agent being stupid. Those signals
 * annotate the fence and raise telemetry; the model still gets to decide, and the
 * host still gets to see.
 */
export interface TaintGuardrailSpec {
  /**
   * Least-severe tool capability refused once the turn has read remote content.
   *
   * - `off` (default) — report only.
   * - `destructive` — refuse hard-to-undo calls.
   * - `write` — refuse those and any state-changing call.
   *
   * Stated as a capability threshold rather than a list of tool `access` values so
   * the guardrail vocabulary stays independent of the tool registry; the kernel
   * maps a tool's declared access onto it.
   */
  afterRemoteRead?: TaintGate;
}

/** Facts a check may read. Deliberately excludes the full profile. */
export interface GuardrailContext {
  stage: GuardrailStage;
  trust: TrustLevel;
  profileId: string;
  canary?: string;
  role?: string;
  slots?: Record<string, string>;
  /** Set on tool-shaped stages; absent for user and system text. */
  provenance?: Provenance;
  /** The profile's lexicon, so a policy's rejection reads in the host's wording. */
  lexicon?: LexiconOverrides;
}

/**
 * One guardrail decision, as it reaches the host and the trace.
 *
 * Carries rule identity and offsets. Matched text rides only under
 * `observability.include.guardrailMatchPreview`, so by default a trace sink can
 * count and locate hits without becoming a second copy of the secret.
 */
export interface GuardrailEvent {
  stage: GuardrailStage;
  trust: TrustLevel;
  action: GuardrailAction;
  hits: GuardrailHit[];
  provenance?: Provenance;
  /** The block verdict's `errorInternal`: builder-only, stripped by `forClient`. */
  errorInternal?: string;
}

/**
 * User-visible output projected out of the turn's events.
 *
 * Structured output travels alongside text so a profile with `outputs.structured`
 * is not invisible to its own egress policy.
 */
export interface OutboundPayload {
  /** Concatenated user-visible text for this attempt. */
  text: string;
  /** Structured output, when the profile emits it. */
  structured?: unknown;
}

/** Evaluates candidate user-visible output before release. */
export type EgressEnforcer = (
  payload: OutboundPayload,
  context: GuardrailContext,
) => Verdict | Promise<Verdict>;

/** Profile egress policy for rejection, retry, or refusal behavior. */
export interface ProfileEgressSpec {
  enforce: EgressEnforcer;
  onBlock?: EgressOnBlock;
  maxRetries?: number;
  /**
   * Characters the progressive gate holds back so `enforce` sees a match split
   * across stream chunks before any of it is released (default
   * `DEFAULT_HOLDBACK`, 256). Smaller releases the reply sooner and covers
   * shorter splits; a tail that could start a canary leak is always held regardless.
   */
  holdback?: number;
}

/** SSRF and network access policy for HTTP and remote MCP tools. */
export interface NetworkGuardrailSpec {
  /**
   * When true, allows connections to localhost / loopback and private subnets
   * (e.g. for local dev/testing). Default: false.
   */
  allowPrivateNetworks?: boolean;
  /** Hostnames or IP addresses permitted regardless of private subnet status. */
  allowedHosts?: string[];
  /**
   * Allowed URL schemes. Defaults to `['https']`, or `['http', 'https']` when
   * `allowPrivateNetworks` is set.
   */
  allowedSchemes?: string[];
}

/** Optional daily turn quota consumed by host HTTP middleware. */
export interface QuotaGuardrailSpec {
  perDay: number;
}

/** Profile guardrail switches enforced by the kernel. */
export interface ProfileGuardrailsSpec {
  /** Optional daily turn quota; omitted means quota enforcement is not configured. */
  quota?: QuotaGuardrailSpec;
  /**
   * Mint a per-turn canary into the system prompt. Default true. The note
   * that binds it is the lexicon's `canary.bind_note` (the profile's `lexicon`
   * may replace it).
   */
  canary?: boolean;
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
  egress?: ProfileEgressSpec;
  /** SSRF and network access policies for HTTP and MCP tools. */
  network?: NetworkGuardrailSpec;
  /** What the turn may still do after reading untrusted remote content. */
  taint?: TaintGuardrailSpec;
}

/** Pre-dispatch policy for structured state leaving a decision profile. */
export type DecisionDisclosureVerdict = Extract<Verdict, { action: 'allow' | 'block' }>;

export type DecisionDisclosureEnforcer = (
  state: unknown,
  context: { destination: 'typesafe'; profileId: string; model: string; questionIds: string[] },
) => DecisionDisclosureVerdict | Promise<DecisionDisclosureVerdict>;

/** Guards reachable from the native decision execution path. */
/**
 * Keeps the shared guardrail vocabulary structurally compatible while the
 * decision registry rejects every inherited field as inert in this release.
 */
export interface DecisionGuardrailsSpec extends Partial<ProfileGuardrailsSpec> {
  disclosure?: { enforce: DecisionDisclosureEnforcer };
}

/** The guardrail field names a `host` profile may set. */
export const HOST_GUARDRAIL_FIELDS = [
  'sanitizeInput',
  'redactSensitive',
  'network',
  'taint',
] as const satisfies readonly (keyof ProfileGuardrailsSpec)[];

/**
 * The guardrail switches a `host` profile may set.
 *
 * A host profile runs no model, so only the guards that fire on the `invokeTool`
 * path exist for it: the detectors applied to model-supplied arguments and to
 * tool result and failure text (`sanitizeInput`, `redactSensitive`), SSRF
 * clearance for declarative HTTP and MCP targets (`network`), and the
 * confused-deputy gate on a tainted turn (`taint`). Everything else in
 * {@link ProfileGuardrailsSpec} — quota, canary, egress — guards a model turn
 * and is refused by `defineProfile` on `type: 'host'`.
 *
 * This is a view of the one guardrail vocabulary, not a second hierarchy.
 */
export type HostGuardrailsSpec = Pick<
  ProfileGuardrailsSpec,
  (typeof HOST_GUARDRAIL_FIELDS)[number]
>;

/**
 * A profile's guardrail switches with defaults applied.
 *
 * Every path resolves through `resolveGuardrailPolicy` so turn and Live ingress
 * cannot drift apart on defaults.
 */
export interface ResolvedGuardrailPolicy {
  sanitizeInput: boolean;
  redactSensitive: boolean;
  canary: boolean;
  egress?: ProfileEgressSpec;
  network?: NetworkGuardrailSpec;
  quota?: QuotaGuardrailSpec;
  taint?: TaintGuardrailSpec;
}
