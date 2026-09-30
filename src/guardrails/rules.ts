/**
 * Every rule id Theorem's own guardrails report, in one place. The trace
 * catalog describes each one, and its description map is keyed by
 * {@link GuardrailRule}, so a new id fails typecheck until it is described.
 * A host's egress `enforce` hook may report ids of its own; those are not here.
 *
 * @module
 */

/** Injection phrasing or sensitive data stripped from text entering the turn. */
export const SANITIZE_RULES = {
  injection: 'sanitize.injection',
  sensitive: 'sanitize.sensitive',
} as const;

/** What the bundled egress policy finds in the model's outbound text. */
export const EGRESS_RULES = {
  canary: 'egress.canary-leak',
  sensitive: 'egress.sensitive-echo',
  boundary: 'egress.system-boundary',
  injection: 'egress.injection-echo', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** Payload could not be rendered for inspection — released output is unverified. */
  unscannable: 'egress.unscannable', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  enforcerError: 'egress.enforcer-error', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** The progressive gate stopped the stream on a host verdict that named no rule. */
  blocked: 'egress.blocked',
} as const;

/** Remote tool content behaving like an instruction to the agent. */
export const DIRECTIVE_RULES = {
  toolName: 'tool_result.names-callable-tool',
  imperative: 'tool_result.imperative',
  authority: 'tool_result.authority-claim',
} as const;

/** The tool boundary: results and failures redacted, and calls flagged or blocked. */
export const TOOL_RULES = {
  resultRedacted: 'tool_result.redacted',
  failureRedacted: 'tool_failure.redacted',
  sensitiveArgument: 'tool_call.sensitive-argument',
  taintedTurn: 'tool_call.tainted-turn',
  steeredTurn: 'tool_call.steered-turn',
} as const;

/** A tool's network target refused before any request was made. */
export const NETWORK_RULES = {
  blocked: 'network.blocked',
} as const;

/** A rule id Theorem's own guardrails report. */
export type GuardrailRule =
  | (typeof SANITIZE_RULES)[keyof typeof SANITIZE_RULES]
  | (typeof EGRESS_RULES)[keyof typeof EGRESS_RULES]
  | (typeof DIRECTIVE_RULES)[keyof typeof DIRECTIVE_RULES]
  | (typeof TOOL_RULES)[keyof typeof TOOL_RULES]
  | (typeof NETWORK_RULES)[keyof typeof NETWORK_RULES];
