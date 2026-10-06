/**
 * What a model is told when a reply a detector blocked is retried: for each detector that
 * matched, its hint and, where a match may be repeated, what it matched. The retry is read at the
 * `repair` boundary like any other text on its way to the model, so a secret quoted here meets
 * the action the profile set there.
 *
 * @module
 */

import { isDetector, type ResolvedDetect } from './detectors.ts';
import type { GuardrailHit } from './event-schemas.ts';
import { type LexiconKey, type LexiconOverrides, lexiconText } from './lexicon.ts';
import { DETECT_RULES, EGRESS_RULES } from './rules.ts';

/** The hint of what stops a reply besides a detector's match. */
const OTHER_HINTS: Readonly<Record<string, LexiconKey>> = {
  [EGRESS_RULES.unscannable]: 'egress.hint_unscannable',
  [EGRESS_RULES.providerToolLeak]: 'egress.hint_provider_tool_leak',
};

/** The rules whose match is the profile's own, and is never repeated. */
const UNQUOTED: readonly string[] = [DETECT_RULES.canary_leak, DETECT_RULES.prompt_leak];

/** How many matches a detector's line quotes, and how much of each. */
const MAX_QUOTED = 3;
const MAX_QUOTE = 120;

const DETECT_PREFIX = 'detect.';

/** The hint of the rule `hit` reports: the profile's, or else the lexicon's. */
function hintOf(hit: GuardrailHit, detect: ResolvedDetect, lexicon?: LexiconOverrides): string {
  const other = OTHER_HINTS[hit.rule];
  if (other) return lexiconText(other, {}, lexicon);
  const key = hit.rule.startsWith(DETECT_PREFIX) ? hit.rule.slice(DETECT_PREFIX.length) : hit.rule;
  if (isDetector(key)) {
    return detect.hints?.[key] ?? lexiconText(`detect.hint.${key}`, {}, lexicon);
  }
  const host = detect.host?.find(({ id }) => id === key);
  const label = host?.label ?? hit.label ?? key;
  return host?.hint ?? lexiconText('detect.hint.own', { label }, lexicon);
}

/** The matched text of `hits` a line may quote: each once, the first few, cut to length. */
function quoted(hits: readonly GuardrailHit[]): string[] {
  const matches = hits.flatMap(({ rule, match }) =>
    match && !UNQUOTED.includes(rule) ? [match] : [],
  );
  return [...new Set(matches)]
    .slice(0, MAX_QUOTED)
    .map((match) => JSON.stringify(match.length > MAX_QUOTE ? match.slice(0, MAX_QUOTE) : match));
}

/** The rejection a retry carries for the `hits` that stopped a reply, a line for each rule among them. */
function retryRejection(
  hits: readonly GuardrailHit[],
  detect: ResolvedDetect,
  lexicon?: LexiconOverrides,
): string {
  const byRule = new Map<string, GuardrailHit[]>();
  for (const hit of hits) byRule.set(hit.rule, [...(byRule.get(hit.rule) ?? []), hit]);
  const lines = [...byRule.values()].map((found) => {
    const hint = hintOf(found[0] as GuardrailHit, detect, lexicon);
    const matches = quoted(found);
    return matches.length > 0
      ? lexiconText('egress.rejection_found', { hint, matches: matches.join(', ') }, lexicon)
      : hint;
  });
  return lexiconText('egress.rejection', { found: lines.join('\n') }, lexicon);
}

export { retryRejection };
