// Must not import from `src/kernel/`: the kernel type-imports `ProfileGuardrailsSpec`, and that edge
// stays one-directional. Other modules under `src/guardrails/` may import kernel types.

import type { EgressChecks } from './egress.ts';
import type { GivenUrls } from './egress-urls.ts';
import type { GuardrailEvent, GuardrailHit, Provenance } from './event-schemas.ts';
import type { LexiconOverrides } from './lexicon.ts';
import type { SensitiveGroups, SensitiveSelection } from './sensitive.ts';

export type { GuardrailEvent, GuardrailHit, Provenance };

/**
 * - `trusted` — author-time profile text (`identity.system`). Sensitive redaction
 *   only; injection redaction would mangle the host's own instructions.
 * - `assembled` — host-built per turn (`req.system`). Interpolates retrieval and
 *   user data, so it is permeable and takes full detection.
 * - `untrusted` — user input, tool results, attachments, delegated agents.
 */
export const TRUST_LEVELS = ['trusted', 'assembled', 'untrusted'] as const;
/** One of {@linkcode TRUST_LEVELS}. */
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** The points a guardrail can run: input, history, system, attachments, tool calls and results, output, thoughts, network, live audio and traces. */
export const GUARDRAIL_STAGES = [
  'input',
  'history',
  'system',
  'attachment',
  'tool_call',
  'tool_result',
  'output_delta',
  'output_final',
  'thought',
  'network',
  'live_inbound',
  'live_outbound',
  'trace',
] as const;
/** One of {@linkcode GUARDRAIL_STAGES}. */
export type GuardrailStage = (typeof GUARDRAIL_STAGES)[number];

/** Does not decide what happens next; that is `onBlock`. */
export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
/** One of {@linkcode SEVERITIES}. */
export type Severity = (typeof SEVERITIES)[number];

/** What a blocked egress does: tell the agent, or refuse to the user. */
export const EGRESS_ON_BLOCK = ['reject_to_agent', 'refuse_to_user'] as const;
/** One of {@linkcode EGRESS_ON_BLOCK}. */
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
/** One of {@linkcode GUARDRAIL_ACTIONS}. */
export type GuardrailAction = (typeof GUARDRAIL_ACTIONS)[number];

/**
 * `local` is host TypeScript the profile registered; `http` and `mcp` are remote
 * services whose bytes the host does not control. `delegated` is another agent
 * answering through the tool boundary — its output is model-generated prose that
 * reads as authoritative, which is why depth is tracked separately.
 */
export const TOOL_ORIGINS = ['local', 'builtin', 'http', 'mcp', 'delegated'] as const;
/** One of {@linkcode TOOL_ORIGINS}. */
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
/** One of {@linkcode ADVISORY_LEVELS}. */
export type AdvisoryLevel = (typeof ADVISORY_LEVELS)[number];

/** Which tool access levels refuse to run once a turn has read untrusted content. */
export const TAINT_GATES = ['off', 'destructive', 'write'] as const;
/** One of {@linkcode TAINT_GATES}. */
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
  /**
   * The canary was in what the model was given besides the system prompt (its
   * input, the user's and tools' history): a reply repeating it is not a
   * leak. It still binds prompt echo.
   */
  canaryGiven?: boolean;
  /**
   * The private stretches of the system prompt as sent (`BoundSystem.private`),
   * when the profile guards it against echo (`guardrails.promptEcho`): a reply
   * repeating one is a leak.
   */
  privateSystem?: readonly string[];
  role?: string;
  slots?: Record<string, string>;
  /** Set on tool-shaped stages; absent for user and system text. */
  provenance?: Provenance;
  /**
   * Canonical absolute URLs in what the model was given this turn or session:
   * the system prompt, the user's input and history, and apart, tool results.
   * An image or link in the reply to any other URL can carry data to its
   * server. The kernel adds to them as the model is given more. Unset: none.
   */
  givenUrls?: GivenUrls;
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

/** A function that judges an outbound payload and returns a verdict. */
export type EgressEnforcer = (
  payload: OutboundPayload,
  context: GuardrailContext,
) => Verdict | Promise<Verdict>;

/** `enforce` or `checks`, never both. */
export interface ProfileEgressSpec {
  /** The host's own check. */
  enforce?: EgressEnforcer;
  /**
   * The bundled policy's checks: `true` runs each at its default, `false` none
   * but the system-prompt leak checks, and an object switches the ones it names.
   */
  checks?: boolean | EgressChecks;
  onBlock?: EgressOnBlock;
  maxRetries?: number;
  /**
   * For a host `enforce` only: characters the progressive gate holds back so
   * `enforce` sees a match split across stream chunks before any of it is
   * released (default `DEFAULT_HOLDBACK`, 256; on Live `LIVE_DEFAULT_HOLDBACK`,
   * 96). The bundled `standardEgressEnforce` holds exactly what could still
   * become a match, and setting this with it is a profile error.
   */
  holdback?: number;
}

/** Which hosts and networks a tool's requests may reach. */
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

/** The guardrails a profile turns on, each with its own settings. */
export interface ProfileGuardrailsSpec {
  /** Omitted means quota enforcement is not configured. */
  quota?: QuotaGuardrailSpec;
  /**
   * Bind a canary into the system prompt. Default true. The note
   * that binds it is the lexicon's `canary.bind_note` (the profile's `lexicon`
   * may replace it).
   */
  canary?: boolean;
  /**
   * With the canary on, also treat a reply that repeats `PROMPT_ECHO_WORDS`
   * (12) consecutive words of the system prompt as a leak: the dump the token
   * alone cannot see. Default true; set false when the prompt holds text the
   * agent is meant to quote word for word.
   */
  promptEcho?: boolean;
  sanitizeInput?: boolean;
  /**
   * Redact sensitive data from untrusted text before the model reads it:
   * `true` (the default) every group, `false` none, an object the groups it
   * switches, the rest on (`ids`, `financial`, `network`, `credentials`).
   */
  redactSensitive?: SensitiveSelection;
  egress?: ProfileEgressSpec;
  network?: NetworkGuardrailSpec;
  taint?: TaintGuardrailSpec;
}

/** Pre-dispatch policy for structured state leaving a decision profile. */
export type DecisionDisclosureVerdict = Extract<Verdict, { action: 'allow' | 'block' }>;

export type DecisionDisclosureEnforcer = (
  state: unknown,
  context: {
    destination: 'typesafe' | 'openrouter';
    profileId: string;
    model: string;
    questionIds: string[];
  },
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

/** A profile's guardrails after defaults are applied. */
export interface ResolvedGuardrailPolicy {
  sanitizeInput: boolean;
  redactSensitive: SensitiveGroups;
  canary: boolean;
  promptEcho: boolean;
  /** `checks` resolved to the bundled policy's `enforce`. */
  egress?: ResolvedEgressSpec;
  network?: NetworkGuardrailSpec;
  quota?: QuotaGuardrailSpec;
  taint?: TaintGuardrailSpec;
}

/** A profile's egress rules with `checks` resolved to the enforcer that runs them. */
export type ResolvedEgressSpec = Omit<ProfileEgressSpec, 'enforce' | 'checks'> & {
  enforce: EgressEnforcer;
};
