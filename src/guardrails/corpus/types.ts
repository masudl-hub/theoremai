/**
 * Shared adversarial corpus types.
 *
 * @module
 */

import type { TurnRequest } from '../../kernel/types.ts';

export interface LiveAttack {
  name: string;
  category: string;
  request: TurnRequest;
  /** Injection markers in user-controlled text must be scrubbed before provider. */
  expectInboundScrub?: boolean;
  /** Raw secrets that must not appear verbatim in sanitized input. */
  inboundSecrets?: string[];
  /** Patterns that must not reach client unless Theorum blocked the turn. */
  forbiddenOutput?: RegExp[];
}

export interface InboundFuzzPayload {
  name: string;
  category: string;
  text: string;
  /** When true, any channel where output === input is a failure. */
  expectCaught: boolean;
}

export interface InboundFuzzResult {
  payload: InboundFuzzPayload;
  channel: string;
  survived: boolean;
  input: string;
  output: string;
}

/** Catalog entry for synthetic canary egress attacks (events built at fuzz time). */
export interface CanaryEgressCatalogEntry {
  name: string;
  category: string;
  shouldBlock: boolean;
}
