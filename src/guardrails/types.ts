// Must not import from `src/kernel/`: the kernel type-imports `ProfileGuardrailsSpec`, and that edge
// stays one-directional. Other modules under `src/guardrails/` may import kernel types.

import type { GuardrailEvent, GuardrailHit, Provenance } from './event-schemas.ts';
import type { LexiconOverrides } from './lexicon.ts';

export type { GuardrailEvent, GuardrailHit, Provenance };

/**
 * - `trusted` — author-time profile text (`identity.system`). Sensitive redaction
 *   only; injection redaction would mangle the host's own instructions.
 * - `assembled` — host-built per turn (`req.system`). Interpolates retrieval and
 *   user data, so it is permeable and takes full detection.
 * - `untrusted` — user input, tool results, attachments, delegated agents.
 */
export const TRUST_LEVELS = ['trusted', 'assembled', 'untrusted'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

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
export type GuardrailStage = (typeof GUARDRAIL_STAGES)[number];

/** Does not decide what happens next; that is `onBlock`. */
export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EGRESS_ON_BLOCK = ['reject_to_agent', 'refuse_to_user'] as const;
export type EgressOnBlock = (typeof EGRESS_ON_BLOCK)[number];

/**
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

export const GUARDRAIL_ACTIONS = [
  'allow',
  'redact',
  'flag',
  'block',
] as const satisfies readonly Verdict['action'][];
export type GuardrailAction = (typeof GUARDRAIL_ACTIONS)[number];

/**
 * `local` is host TypeScript the profile registered; `http` and `mcp` are remote
 * services whose bytes the host does not control. `delegated` is another agent
 * answering through the tool boundary — its output is model-generated prose that
 * reads as authoritative, which is why depth is tracked separately.
 */
export const TOOL_ORIGINS = ['local', 'builtin', 'http', 'mcp', 'delegated'] as const;
export type ToolOrigin = (typeof TOOL_ORIGINS)[number];

/**
 * Once a turn has read attacker-influenceable bytes, a later tool call is a
 * confused-deputy risk: the content can ask the agent to act, and the agent has
 * authority the content does not. Sources are kept in order so a policy can reason
 * about depth as well as presence.
 */
export interface TurnTaint {
  sources: Provenance[];
  /**
   * Separates "read something remote" from "read something that tried to steer
   * me". The second is far rarer, so a gate keyed on it refuses far less
   * legitimate work.
   */
  suspicious: GuardrailHit[];
}

/**
 * Not a probability: there is no calibrated model behind it. `elevated` means one
 * directive signal alongside an external destination; `high` means the content
 * named a tool the model can call, or several signals agreed.
 */
export const ADVISORY_LEVELS = ['none', 'elevated', 'high'] as const;
export type AdvisoryLevel = (typeof ADVISORY_LEVELS)[number];

export const TAINT_GATES = ['off', 'destructive', 'write'] as const;
export type TaintGate = (typeof TAINT_GATES)[number];

/**
 * Enforcement is opt-in: every remote read is reported, but refusing tool calls
 * changes what working agents may do, so the host declares which access levels
 * to gate rather than having the kernel guess.
 *
 * Only structural facts gate tool calls. Content signals from `tool-directives.ts` deliberately have no gate here. They
 * are pattern matches with no measured precision, and refusing a tool call on an
 * unpredictable signal makes an agent unreliable rather than safe — the failure is
 * invisible to the user and looks like the agent being stupid. Those signals
 * annotate the fence and raise telemetry; the model still gets to decide, and the
 * host still gets to see.
 */
export interface TaintGuardrailSpec {
  /**
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
 * Structured output travels alongside text so a profile with `outputs.structured`
 * is not invisible to its own egress policy.
 */
export interface OutboundPayload {
  /** Concatenated user-visible text for this attempt. */
  text: string;
  structured?: unknown;
}

export type EgressEnforcer = (
  payload: OutboundPayload,
  context: GuardrailContext,
) => Verdict | Promise<Verdict>;

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

export interface NetworkGuardrailSpec {
  /** Allows localhost, loopback and private subnets (local dev and testing). Default false. */
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

export interface ProfileGuardrailsSpec {
  /** Omitted means quota enforcement is not configured. */
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
  network?: NetworkGuardrailSpec;
  taint?: TaintGuardrailSpec;
}

/** Pre-dispatch policy for structured state leaving a decision profile. */
export type DecisionDisclosureVerdict = Extract<Verdict, { action: 'allow' | 'block' }>;

export type DecisionDisclosureEnforcer = (
  state: unknown,
  context: { destination: 'typesafe'; profileId: string; model: string; questionIds: string[] },
) => DecisionDisclosureVerdict | Promise<DecisionDisclosureVerdict>;

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
] as const satisfies readonly (keyof ProfileGuardrailsSpec)[];

/** The guardrails that fire on the `invokeTool` path; the rest guard a model turn. */
export type HostGuardrailsSpec = Pick<
  ProfileGuardrailsSpec,
  (typeof HOST_GUARDRAIL_FIELDS)[number]
>;

export interface ResolvedGuardrailPolicy {
  sanitizeInput: boolean;
  redactSensitive: boolean;
  canary: boolean;
  egress?: ProfileEgressSpec;
  network?: NetworkGuardrailSpec;
  quota?: QuotaGuardrailSpec;
  taint?: TaintGuardrailSpec;
}
