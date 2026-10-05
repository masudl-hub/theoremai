// invariant: The one place a match becomes an action. Every boundary calls `detectAt`; nothing
// else reads the matrix to decide what a match does.

import { applySpans, type RedactSpan } from '../observability/spans.ts';
import { type Boundary, recordOf, TOOL_BOUNDARIES } from './boundaries.ts';
import { DETECTORS, type DetectAction, type Detector, type ResolvedDetect } from './detectors.ts';
import type { GuardrailEvent, GuardrailHit } from './event-schemas.ts';
import { hitFromSpan } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { DETECT_RULES } from './rules.ts';
import { SENSITIVE_GROUPS, type SensitiveGroups, sensitiveSpans } from './sensitive.ts';
import type { GuardrailStage, Provenance, TrustLevel } from './types.ts';

/** What happened to text at a boundary: nothing matched, or the strongest action among the matches. */
type DetectOutcome = 'allow' | Exclude<DetectAction, 'ignore'>;

/** Text read as it crossed a boundary. */
interface Detection {
  action: DetectOutcome;
  /** The text to let through: unchanged, or with placeholders. Absent on `block`: nothing crosses. */
  text?: string;
  /** Every match, each named for its detector. */
  hits: GuardrailHit[];
}

const STRENGTH: readonly DetectOutcome[] = ['allow', 'flag', 'redact', 'block'];

function stronger(left: DetectOutcome, right: DetectOutcome): DetectOutcome {
  return STRENGTH.indexOf(right) > STRENGTH.indexOf(left) ? right : left;
}

/** Each sensitive group alone, for a scan that reads one detector at a time. */
const ONLY: Readonly<Record<keyof SensitiveGroups, SensitiveGroups>> = recordOf(
  SENSITIVE_GROUPS,
  (group) => recordOf(SENSITIVE_GROUPS, (other) => other === group),
);

function spansOf(detector: Detector, text: string): RedactSpan[] {
  return detector === 'injection' ? injectionSpans(text) : sensitiveSpans(text, ONLY[detector]);
}

/** Reads `text` as it crosses `boundary` under the profile's resolved matrix. */
function detectAt(text: string, boundary: Boundary, detect: ResolvedDetect): Detection {
  const hits: GuardrailHit[] = [];
  const redact: RedactSpan[] = [];
  let action: DetectOutcome = 'allow';
  for (const detector of DETECTORS) {
    const chosen = detect[detector][boundary];
    if (chosen === 'ignore') continue;
    const spans = spansOf(detector, text);
    if (spans.length === 0) continue;
    for (const span of spans) hits.push(hitFromSpan(text, span, DETECT_RULES[detector], 'high'));
    if (chosen === 'redact') redact.push(...spans);
    action = stronger(action, chosen);
  }
  if (action === 'block') return { action, hits };
  return { action, text: applySpans(text, redact), hits };
}

/** `text` with every match of `detectors` replaced by its placeholder, whatever a profile sets. */
function redactDetectors(text: string, detectors: readonly Detector[]): string {
  return applySpans(
    text,
    detectors.flatMap((detector) => spansOf(detector, text)),
  );
}

/** Reads several texts crossing one boundary and keeps what was found across them. */
interface BoundaryReader {
  /** The text to let through, or `''` once a match blocks: the caller reads `found().action`. */
  read(text: string): string;
  found(): Pick<Detection, 'action' | 'hits'>;
}

/** A reader for everything crossing `boundary` in one request. */
function boundaryReader(boundary: Boundary, detect: ResolvedDetect): BoundaryReader {
  const hits: GuardrailHit[] = [];
  let action: DetectOutcome = 'allow';
  return {
    read(text) {
      const detected = detectAt(text, boundary, detect);
      hits.push(...detected.hits);
      action = stronger(action, detected.action);
      return detected.text ?? '';
    },
    found: () => ({ action, hits }),
  };
}

const TOOL_STAGE: Readonly<Record<string, GuardrailStage>> = Object.fromEntries(
  TOOL_BOUNDARIES.map((boundary) => [
    boundary,
    boundary.startsWith('tool_arguments') ? 'tool_call' : 'tool_result',
  ]),
);

/** The trace stage each boundary reports under. */
const BOUNDARY_STAGE: Readonly<Record<Boundary, GuardrailStage>> = {
  user: 'input',
  slots: 'input',
  repair: 'input',
  attachment: 'attachment',
  voice: 'attachment',
  history: 'history',
  injected: 'history',
  system: 'system',
  live_user: 'live_inbound',
  ...(TOOL_STAGE as Record<(typeof TOOL_BOUNDARIES)[number], GuardrailStage>),
  reply: 'output_final',
  reply_structured: 'output_final',
  live_reply: 'live_outbound',
  thought: 'thought',
};

/** Host-built per-turn system text is `assembled`; everything else a detector reads is `untrusted`. */
function trustAt(boundary: Boundary): TrustLevel {
  return boundary === 'system' ? 'assembled' : 'untrusted';
}

/** The guardrail event for what was found at a boundary, or `undefined` when nothing matched. */
function detectEvent(
  boundary: Boundary,
  found: Pick<Detection, 'action' | 'hits'>,
  provenance?: Provenance,
): GuardrailEvent | undefined {
  if (found.action === 'allow') return undefined;
  return {
    stage: BOUNDARY_STAGE[boundary],
    boundary,
    trust: trustAt(boundary),
    action: found.action,
    hits: found.hits,
    ...(provenance ? { provenance } : {}),
  };
}

export type { BoundaryReader, Detection, DetectOutcome };
export { boundaryReader, detectAt, detectEvent, redactDetectors };
