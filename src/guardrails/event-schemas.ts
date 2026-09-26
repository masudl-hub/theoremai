/**
 * Guardrail and failure shapes that ride on turn events.
 *
 * Each shape is a documented type and a zod schema checked against it
 * (`Equals`): the type is what builders read; the schema is what a wire parser
 * runs. A field in one and not the other fails the build.
 *
 * Like `types.ts`, this module imports nothing from `src/kernel/` but the
 * dependency-free `Equals` check; the kernel's turn-event schemas
 * (`src/kernel/turn-events.ts`) import these.
 *
 * @module
 */

import { z } from 'zod';
import type { Equals } from '../kernel/util/exact-type.ts';
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
/** What kind of failure happened (`ERROR_KINDS`). */
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
export const errorCopiesSchema: z.ZodType<ErrorCopies> = errorCopies;

/**
 * Where a piece of content entered the turn from.
 *
 * `depth` is hops from the user's turn: a direct tool call is 1; a tool result
 * produced by a delegated agent that itself called tools is deeper. Depth
 * matters because a two-hop delegation can otherwise launder remote content
 * into trusted-looking output.
 */
export interface Provenance {
  origin: ToolOrigin;
  /** Registered tool name. */
  tool: string;
  depth: number;
}
const provenance = z.object({
  origin: z.enum(TOOL_ORIGINS),
  tool: z.string(),
  depth: z.number(),
});
true satisfies Equals<z.infer<typeof provenance>, Provenance>;

/** One detector match. */
export interface GuardrailHit {
  /** Stable rule id, e.g. `injection.instruction-override`. */
  rule: string;
  severity: Severity;
  /** Offsets into the inspected text; absent for whole-payload checks. */
  span?: { start: number; end: number };
  /**
   * Exact matched text, whole. Present when detectors had the source text.
   * Stripped from host/trace unless `observability.include.guardrailMatchPreview`.
   */
  match?: string;
}
const guardrailHit = z.object({
  rule: z.string(),
  severity: z.enum(SEVERITIES),
  span: z.object({ start: z.number(), end: z.number() }).optional(),
  match: z.string().optional(),
});
true satisfies Equals<z.infer<typeof guardrailHit>, GuardrailHit>;

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
const guardrailEvent = z.object({
  stage: z.enum(GUARDRAIL_STAGES),
  trust: z.enum(TRUST_LEVELS),
  action: z.enum(GUARDRAIL_ACTIONS),
  hits: z.array(guardrailHit),
  provenance: provenance.optional(),
  errorInternal: z.string().optional(),
});
true satisfies Equals<z.infer<typeof guardrailEvent>, GuardrailEvent>;
export const guardrailEventSchema: z.ZodType<GuardrailEvent> = guardrailEvent;
