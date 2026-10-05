/**
 * Every pattern the bundled egress policy matches on the reply, in the order
 * the streaming hold's automata number them (`egress-automata.ts`, generated
 * from this list by `scripts/gen-egress-automata.ts`).
 *
 * @module
 */

import { IMAGE_PATTERNS, LINK_PATTERNS } from './egress-urls.ts';
import {
  BASE64_BLOB,
  HEX_BLOB,
  INJECTION_PATTERNS,
  PIPE_SEPARATED,
  SPACED_LETTERS,
} from './injection-patterns.ts';
import { CARD_CANDIDATE, SENSITIVE_PATTERNS, type SensitiveGroup } from './sensitive.ts';

const SYSTEM_BOUNDARY =
  /This turn\x27s canary is|Your canary token is|<\s*(?:\/\s*)?user_data(?:\s*(?:\/\s*)?>)?/i; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)

/** What a match of the pattern means: the rule it trips, or the blob its filter decodes. */
type EgressPatternKind =
  | 'injection'
  | 'sensitive'
  | 'card'
  | 'boundary'
  | 'base64'
  | 'hex'
  | 'spaced'
  | 'pipe'
  | 'image'
  | 'link';

interface EgressPattern {
  kind: EgressPatternKind;
  pattern: RegExp;
  /** The sensitive-data group a `sensitive` or `card` pattern belongs to. */
  group?: SensitiveGroup;
}

/**
 * Patterns matched on the reply as written. The injection patterns come first:
 * the rewritten views (typo, Unicode, rot13, leet, URL) match those alone.
 */
const EGRESS_PATTERNS: readonly EgressPattern[] = [
  ...INJECTION_PATTERNS.map((pattern) => ({ kind: 'injection' as const, pattern })),
  ...SENSITIVE_PATTERNS.map(({ group, pattern }) => ({
    kind: 'sensitive' as const,
    pattern,
    group,
  })),
  { kind: 'card', pattern: CARD_CANDIDATE, group: 'financial' },
  { kind: 'boundary', pattern: new RegExp(SYSTEM_BOUNDARY.source, 'gi') },
  { kind: 'base64', pattern: BASE64_BLOB },
  { kind: 'hex', pattern: HEX_BLOB },
  { kind: 'spaced', pattern: SPACED_LETTERS },
  { kind: 'pipe', pattern: PIPE_SEPARATED },
  ...IMAGE_PATTERNS.map((pattern) => ({ kind: 'image' as const, pattern })),
  ...LINK_PATTERNS.map((pattern) => ({ kind: 'link' as const, pattern })),
];

/** A reply repeating `note`, a canary note's own words (`canaryNoteMarker`), as written, case aside. */
function notePattern(note: string): RegExp {
  return new RegExp(note.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&'), 'gi');
}

export type { EgressPattern, EgressPatternKind };
export { EGRESS_PATTERNS, notePattern, SYSTEM_BOUNDARY };
