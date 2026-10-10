/** lexicon-exempt-file: adversarial corpus fixture — not runtime user or model copy (P2) */
import type { TurnRequest } from '../../kernel/types.ts';

/** A turn request that attacks a profile, with what its sanitized input and its reply must not show. */
export interface LiveAttack {
  name: string;
  category: string;
  request: TurnRequest;
  /** Injection markers in user-controlled text must be scrubbed before provider. */
  expectInboundScrub?: boolean;
  /** Raw secrets that must not appear verbatim in sanitized input. */
  inboundSecrets?: string[];
  /** Patterns that must not reach client unless Theorem blocked the turn. */
  forbiddenOutput?: RegExp[];
}

/** Hostile text sent through each inbound channel, and whether the guardrails must change it. */
export interface InboundFuzzPayload {
  name: string;
  category: string;
  text: string;
  /** When true, any channel where output === input is a failure. */
  expectCaught: boolean;
}

/** What one channel did to one payload: whether it came out unchanged, with the input and output. */
export interface InboundFuzzResult {
  payload: InboundFuzzPayload;
  channel: string;
  survived: boolean;
  input: string;
  output: string;
}

/** The name and category of a canary egress attack, and whether the gate must block it. */
export interface CanaryEgressCatalogEntry {
  name: string;
  category: string;
  shouldBlock: boolean;
}
