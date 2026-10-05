/**
 * Every rule id Theorem's own guardrails report, in one place. The trace
 * catalog describes each one, and its description map is keyed by
 * {@link GuardrailRule}, so a new id fails typecheck until it is described.
 * A host's egress `enforce` hook may report ids of its own; those are not here.
 *
 * @module
 */

import type { Detector } from './detectors.ts';

/** What a detector found, the same id at every boundary; the event names the boundary. */
export const DETECT_RULES = {
  ids: 'detect.ids',
  financial: 'detect.financial',
  network: 'detect.network',
  credentials: 'detect.credentials',
  injection: 'detect.injection',
  canary_leak: 'detect.canary_leak',
  prompt_leak: 'detect.prompt_leak',
} as const satisfies Record<Detector, string>;

/** What the bundled egress policy finds in the model's outbound text. */
export const EGRESS_RULES = {
  /**
   * A provider-side built-in tool carried the canary or the system prompt. It
   * ran before Theorem saw it: the data already left, so this is an incident.
   */
  providerToolLeak: 'egress.provider-tool-leak', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  boundary: 'egress.system-boundary',
  /** An image loads a URL the model was not given, from a host not allowed. */
  image: 'egress.image-exfil', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  /** A link goes to a URL the model was not given, on a host not allowed. */
  link: 'egress.link-exfil', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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
  override: 'tool_result.override',
} as const;

/** A tool call refused for what the turn read before it. */
export const TOOL_RULES = {
  taintedTurn: 'tool_call.tainted-turn',
  steeredTurn: 'tool_call.steered-turn',
} as const;

/** A tool's network target refused before any request was made. */
export const NETWORK_RULES = {
  blocked: 'network.blocked',
} as const;

/** A rule id Theorem's own guardrails report. */
export type GuardrailRule =
  | (typeof DETECT_RULES)[keyof typeof DETECT_RULES]
  | (typeof EGRESS_RULES)[keyof typeof EGRESS_RULES]
  | (typeof DIRECTIVE_RULES)[keyof typeof DIRECTIVE_RULES]
  | (typeof TOOL_RULES)[keyof typeof TOOL_RULES]
  | (typeof NETWORK_RULES)[keyof typeof NETWORK_RULES];
