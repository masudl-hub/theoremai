/**
 * Host egress rules: the patterns a host adds to (or runs instead of) the
 * bundled egress policy, and the tables `agents egress-compile` writes for
 * them. Shared by the build-time compiler and `egressPolicy`.
 *
 * @module
 */

import { TheoremError } from './error.ts';
import type { Severity } from './types.ts';

/** One host egress rule: a reply matching `pattern` is blocked under `rule`. */
interface EgressRule {
  /** The rule id hits carry, e.g. `acme.account-number`. `egress.` ids are the bundled policy's. */
  rule: string;
  /** Matched on the reply as written. No sticky (`y`) flag; `g` is implied. */
  pattern: RegExp;
  /** Default `high`. */
  severity?: Severity;
}

/**
 * An automaton over UTF-16 code units, as tables.
 *
 * - `classStarts`: first code unit of each character class; class k covers
 *   `[classStarts[k], classStarts[k+1])`.
 * - `charsets`: each charset as the sorted class ids it contains.
 * - `initials`: the initial node of each pattern.
 * - `nodes`: each node as `[pattern, final (0/1), target, charset, target, charset, ...]`.
 */
interface EgressAutomatonData {
  classStarts: readonly number[];
  charsets: readonly (readonly number[])[];
  initials: readonly number[];
  nodes: readonly (readonly number[])[];
}

/** What `compileEgressRules` writes: the rules it read, and their automaton. */
interface CompiledEgressRules {
  /** `EGRESS_COMPILER_VERSION` of the compiler that wrote it. */
  compiler: number;
  /** Each rule's id and pattern, in order: `egressPolicy` refuses a table that no longer matches its rules. */
  rules: readonly { rule: string; source: string; flags: string }[];
  automaton: EgressAutomatonData;
}

/** Bumped whenever the compiled table's layout or meaning changes. */
const EGRESS_COMPILER_VERSION = 1;

const RESERVED_PREFIX = 'egress.';

function configError(message: string): TheoremError {
  return new TheoremError('config', message);
}

/** Rule ids are non-empty, unique and not the bundled policy's; patterns are not sticky. */
function assertEgressRules(rules: readonly EgressRule[]): void {
  const seen = new Set<string>();
  for (const { rule, pattern } of rules) {
    if (typeof rule !== 'string' || !rule.trim()) {
      throw configError('egress rule ids must be non-empty strings'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (rule.startsWith(RESERVED_PREFIX)) {
      throw configError(
        // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        `egress rule ${rule}: ids starting "${RESERVED_PREFIX}" are the bundled policy's`,
      );
    }
    if (seen.has(rule)) {
      throw configError(`egress rule ${rule} is listed twice`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    seen.add(rule);
    if (!(pattern instanceof RegExp)) {
      throw configError(`egress rule ${rule}: pattern must be a RegExp`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    if (pattern.sticky) {
      throw configError(
        // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        `egress rule ${rule}: a sticky (y) pattern only matches where the last one ended`,
      );
    }
  }
}

/** The rules as a compiled table records them. */
function ruleFingerprint(rules: readonly EgressRule[]): CompiledEgressRules['rules'] {
  return rules.map(({ rule, pattern }) => ({ rule, source: pattern.source, flags: pattern.flags }));
}

/** The pattern, global, for scanning every match. */
function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.global ? pattern.flags : `${pattern.flags}g`);
}

export type { CompiledEgressRules, EgressAutomatonData, EgressRule };
export { assertEgressRules, EGRESS_COMPILER_VERSION, globalPattern, ruleFingerprint };
