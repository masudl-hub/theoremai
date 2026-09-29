/**
 * `egressPolicy`: the bundled egress policy with host rules added, or host
 * rules alone. The rules' automata come from `agents egress-compile`, so the
 * stream holds exactly the text a host match could still be under way in, as
 * it does for the bundled patterns.
 *
 * @module
 */

import { collectEgressHits, hitsEnforcer, promptLeakHits } from './egress.ts';
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
  rules: readonly EgressRule[];
  /** `compiledEgressRules` from the module `agents egress-compile` wrote for these rules. */
  compiled: CompiledEgressRules;
  /** Also run the bundled policy (canary, prompt echo, sensitive data, boundary, injection echo). Default true. */
  bundled?: boolean;
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
    new TheoremError(
      'config',
      `egressPolicy: the compiled rules ${why}; run \`agents egress-compile\` again`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  if (compiled?.compiler !== EGRESS_COMPILER_VERSION) {
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    throw stale(`come from compiler ${compiled?.compiler}, this one is ${EGRESS_COMPILER_VERSION}`);
  }
  const want = ruleFingerprint(rules);
  if (JSON.stringify(compiled.rules) !== JSON.stringify(want)) {
    throw stale('were compiled from different rules'); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

/** An egress enforce that blocks on each host rule, and on the bundled policy unless `bundled: false`. */
function egressPolicy({ rules, compiled, bundled = true }: EgressPolicyOptions): EgressEnforcer {
  assertEgressRules(rules);
  assertCompiledFor(rules, compiled);
  const host = rules.map(({ rule, pattern, severity }) => ({
    rule,
    severity: severity ?? ('high' as const),
    pattern: globalPattern(pattern),
  }));
  const enforce = hitsEnforcer((text, context) => {
    const hits = bundled
      ? collectEgressHits(text, context.canary, context.system)
      : promptLeakHits(text, context.canary, context.system);
    hits.push(...ruleHits(text, host));
    return hits;
  });
  const scan: EgressStreamOptions['host'] = { automaton: compiled.automaton, rules: host };
  registerStreamPlan(enforce, () => createEgressStream({ bundled, host: scan }));
  return enforce;
}

export type { EgressPolicyOptions };
export { egressPolicy };
