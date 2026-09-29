/**
 * Every pattern the bundled egress policy matches on the reply, in the order
 * the streaming hold's automata number them (`egress-automata.ts`, generated
 * from this list by `scripts/gen-egress-automata.ts`).
 *
 * @module
 */

import {
  BASE64_BLOB,
  HEX_BLOB,
  INJECTION_PATTERNS,
  PIPE_SEPARATED,
  SPACED_LETTERS,
} from './injection-patterns.ts';
import { CARD_CANDIDATE, KEY_PATTERNS } from './sensitive.ts';

const SYSTEM_BOUNDARY = /This turn\x27s canary is|<\/?user_data>/i; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)

/** What a match of the pattern means: the rule it trips, or the blob its filter decodes. */
type EgressPatternKind =
  | 'injection'
  | 'sensitive'
  | 'card'
  | 'boundary'
  | 'base64'
  | 'hex'
  | 'spaced'
  | 'pipe';

interface EgressPattern {
  kind: EgressPatternKind;
  pattern: RegExp;
}

/**
 * Patterns matched on the reply as written. The injection patterns come first:
 * the rewritten views (typo, Unicode, rot13, leet, URL) match those alone.
 */
const EGRESS_PATTERNS: readonly EgressPattern[] = [
  ...INJECTION_PATTERNS.map((pattern) => ({ kind: 'injection' as const, pattern })),
  ...KEY_PATTERNS.map((pattern) => ({ kind: 'sensitive' as const, pattern })),
  { kind: 'card', pattern: CARD_CANDIDATE },
  { kind: 'boundary', pattern: new RegExp(SYSTEM_BOUNDARY.source, 'gi') },
  { kind: 'base64', pattern: BASE64_BLOB },
  { kind: 'hex', pattern: HEX_BLOB },
  { kind: 'spaced', pattern: SPACED_LETTERS },
  { kind: 'pipe', pattern: PIPE_SEPARATED },
];

export type { EgressPattern, EgressPatternKind };
export { EGRESS_PATTERNS, SYSTEM_BOUNDARY };
