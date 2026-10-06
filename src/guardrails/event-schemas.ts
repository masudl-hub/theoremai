// invariant: Imports nothing from `src/kernel/` but the dependency-free `Equals`: `src/kernel/turn-events.ts` imports these.

import { z } from 'zod';
import type { Equals } from '../kernel/util/exact-type.ts';
import { BOUNDARIES, type Boundary } from './boundaries.ts';
import { LEXICON_KEYS, type LexiconKey } from './lexicon.ts';
import { ERROR_KINDS, type ErrorKind } from './theorem-error.ts';
import {
  GUARDRAIL_ACTIONS,
  GUARDRAIL_STAGES,
  type GuardrailAction,
  type GuardrailStage,
  SEVERITIES,
  type Severity,
  TOOL_ORIGINS,
  type ToolOrigin,
  TRUST_LEVELS,
  type TrustLevel,
} from './types.ts';

const errorKind = z.enum(ERROR_KINDS);
true satisfies Equals<z.infer<typeof errorKind>, ErrorKind>;
/** The schema an error kind parses against. */
export const errorKindSchema: z.ZodType<ErrorKind> = errorKind;

/** Wording for the user more specific than its kind's: a lexicon key and its parameters. */
export interface ErrorCopy {
  key: LexiconKey;
  params?: Record<string, string | number>;
}
const errorCopy = z.object({
  key: z.enum(LEXICON_KEYS),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
true satisfies Equals<z.infer<typeof errorCopy>, ErrorCopy>;

/** One line of wording, or one per problem found. */
export type ErrorCopies = ErrorCopy | readonly ErrorCopy[];
const errorCopies = z.union([errorCopy, z.array(errorCopy).readonly()]);
true satisfies Equals<z.infer<typeof errorCopies>, ErrorCopies>;
/** The schema error wording parses against. */
export const errorCopiesSchema: z.ZodType<ErrorCopies> = errorCopies;

/**
 * `depth` is hops from the user's turn: a direct tool call is 1; a tool result
 * produced by a delegated agent that itself called tools is deeper. Depth
 * matters because a two-hop delegation can otherwise launder remote content
 * into trusted-looking output.
 */
export interface Provenance {
  origin: ToolOrigin;
  tool: string;
  depth: number;
}
const provenance = z.object({
  origin: z.enum(TOOL_ORIGINS),
  tool: z.string(),
  depth: z.number(),
});
true satisfies Equals<z.infer<typeof provenance>, Provenance>;

/** One rule match: the rule id, its severity, where it matched and, when kept, the matched text. */
export interface GuardrailHit {
  /** Stable rule id, e.g. `egress.canary-leak`. */
  rule: string;
  severity: Severity;
  /** Offsets into the inspected text; absent for whole-payload checks. */
  span?: { start: number; end: number };
  /** Stripped from host and trace unless `observability.include.guardrailMatchPreview`. */
  match?: string;
  /**
   * What the rule catches, in a few words, for a host's own rule: Theorem's
   * rules are named in the trace catalog. Shown in place of the id.
   */
  label?: string;
  /** Why a match matters, in a sentence, for a host's own rule. */
  doc?: string;
  /** The name of the host's pattern that matched; unset for a match of Theorem's own patterns. */
  pattern?: string;
  /** What about the match made it one, for `tool_instructions`: `override`, `tool_name`, `order` or `authority`. */
  signal?: string;
}
const guardrailHit = z.object({
  rule: z.string(),
  severity: z.enum(SEVERITIES),
  span: z.object({ start: z.number(), end: z.number() }).optional(),
  match: z.string().optional(),
  label: z.string().optional(),
  doc: z.string().optional(),
  pattern: z.string().optional(),
  signal: z.string().optional(),
});
true satisfies Equals<z.infer<typeof guardrailHit>, GuardrailHit>;

/**
 * Matched text rides only under `observability.include.guardrailMatchPreview`, so by default a
 * trace sink can count and locate hits without becoming a second copy of the secret.
 */
export interface GuardrailEvent {
  stage: GuardrailStage;
  /** Where the text was crossing, when a detector read it there. */
  boundary?: Boundary;
  trust: TrustLevel;
  action: GuardrailAction;
  hits: GuardrailHit[];
  provenance?: Provenance;
  /** The block verdict's `errorInternal`: builder-only, stripped by `forClient`. */
  errorInternal?: string;
}
const guardrailEvent = z.object({
  stage: z.enum(GUARDRAIL_STAGES),
  boundary: z.enum(BOUNDARIES).optional(),
  trust: z.enum(TRUST_LEVELS),
  action: z.enum(GUARDRAIL_ACTIONS),
  hits: z.array(guardrailHit),
  provenance: provenance.optional(),
  errorInternal: z.string().optional(),
});
true satisfies Equals<z.infer<typeof guardrailEvent>, GuardrailEvent>;
/** The schema a guardrail event parses against. */
export const guardrailEventSchema: z.ZodType<GuardrailEvent> = guardrailEvent;
