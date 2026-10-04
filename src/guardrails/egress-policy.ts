/**
 * `egressPolicy`: the bundled egress checks a host selects, with its own
 * rules added. The rules' automata come from `agents egress-compile`, so the
 * stream holds exactly the text a host match could still be under way in, as
 * it does for the bundled patterns.
 *
 * @module
 */

import {
  collectEgressHits,
  type EgressChecks,
  egressChecksProblem,
  egressScope,
  hitsEnforcer,
  NO_CHECKS,
  registerEgressChecks,
  resolveEgressChecks,
} from './egress.ts';
import {
  assertEgressRules,
  type CompiledEgressRules,
  EGRESS_COMPILER_VERSION,
  type EgressRule,
  globalPattern,
  ruleFingerprint,
} from './egress-rules.ts';
import {
  createEgressStream,
  type EgressStreamOptions,
  registerStreamPlan,
} from './egress-stream.ts';
import { TheoremError } from './error.ts';
import { hitFromSpan } from './hits.ts';
import type { EgressEnforcer, GuardrailHit, Severity } from './types.ts';

interface EgressPolicyOptions {
  /** Host rules, blocked on alongside the bundled checks. */
  rules?: readonly EgressRule[];
  /** `compiledEgressRules` from the module `agents egress-compile` wrote for `rules`. */
  compiled?: CompiledEgressRules;
  /**
   * The bundled checks: `true` (the default) runs each at its default, `false`
   * none, and an object switches the ones it names (`EgressChecks`). The
   * system-prompt leak checks run either way.
   */
  bundled?: boolean | EgressChecks;
}
/** Every host rule's matches in `text`. An empty match is not a hit. */
function ruleHits(
  text: string,
  rules: readonly { rule: string; severity: Severity; pattern: RegExp }[],
): GuardrailHit[] {
  const hits: GuardrailHit[] = [];
  for (const { rule, severity, pattern } of rules) {
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) continue;
      hits.push(
        hitFromSpan(
          text,
          { start: match.index, end: match.index + match[0].length },
          rule,
          severity,
        ),
      );
    }
  }
  return hits;
}

/** A compiled table that no longer matches `rules` would hold for the wrong patterns. */
function assertCompiledFor(rules: readonly EgressRule[], compiled: CompiledEgressRules): void {
  const stale = (why: string): TheoremError =>
    configError(`the compiled rules ${why}; run \`agents egress-compile\` again`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (compiled?.compiler !== EGRESS_COMPILER_VERSION) {
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    throw stale(`come from compiler ${compiled?.compiler}, this one is ${EGRESS_COMPILER_VERSION}`);
  }
  const want = ruleFingerprint(rules);
  if (JSON.stringify(compiled.rules) !== JSON.stringify(want)) {
    throw stale('were compiled from different rules'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

function configError(message: string): TheoremError {
  return new TheoremError('config', `egressPolicy: ${message}`);
}

function assertEgressChecks(checks: boolean | EgressChecks): void {
  const problem = egressChecksProblem('bundled', checks);
  if (problem !== undefined) throw configError(problem);
}

/** An egress enforce that blocks on each host rule and on the bundled checks `bundled` selects. */
function egressPolicy({
  rules = [],
  compiled,
  bundled = true,
}: EgressPolicyOptions = {}): EgressEnforcer {
  assertEgressRules(rules);
  if (rules.length > 0) {
    if (compiled === undefined) {
      throw configError('rules need the compiled table `agents egress-compile` writes for them'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    }
    assertCompiledFor(rules, compiled);
  }
  assertEgressChecks(bundled);
  const checks =
    bundled === false ? NO_CHECKS : resolveEgressChecks(bundled === true ? {} : bundled);
  const host = rules.map(({ rule, pattern, severity }) => ({
    rule,
    severity: severity ?? ('high' as const),
    pattern: globalPattern(pattern),
  }));
  const enforce = hitsEnforcer((text, context) => {
    const hits = collectEgressHits(text, egressScope(context), checks);
    hits.push(...ruleHits(text, host));
    return hits;
  });
  const scan: EgressStreamOptions['host'] =
    compiled && host.length > 0 ? { automaton: compiled.automaton, rules: host } : undefined;
  registerStreamPlan(enforce, (context) => {
    const { given, note } = egressScope(context);
    return createEgressStream({
      checks,
      ...(scan ? { host: scan } : {}),
      ...(given ? { given } : {}),
      ...(note ? { note } : {}),
    });
  });
  registerEgressChecks(enforce, checks);
  return enforce;
}

export type { EgressPolicyOptions };
export { egressPolicy };
