// invariant: The one place a match becomes an action. Every boundary calls `detectAt`; nothing
// else reads the matrix to decide what a match does.

import { applySpans, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';
import { type Boundary, recordOf, TOOL_BOUNDARIES } from './boundaries.ts';
import { canaryLeakRanges } from './canary.ts';
import {
  DETECTORS,
  type DetectAction,
  type Detector,
  detects,
  type ResolvedAllow,
  type ResolvedDetect,
  type UrlDetector,
} from './detectors.ts';
import { boundaryNote, type LeakScope } from './egress.ts';
import { notePattern, SYSTEM_BOUNDARY } from './egress-patterns.ts';
import { imageLeakSpans, linkLeakSpans, type UrlScope } from './egress-urls.ts';
import type { GuardrailEvent, GuardrailHit } from './event-schemas.ts';
import { CANARY_HIT, hitFromSpan, PROMPT_ECHO_HIT } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { promptEchoRanges } from './prompt-echo.ts';
import { DETECT_RULES } from './rules.ts';
import { SENSITIVE_GROUPS, type SensitiveGroups, sensitiveSpans } from './sensitive.ts';
import type {
  GuardrailContext,
  GuardrailStage,
  Provenance,
  ResolvedGuardrailPolicy,
  TrustLevel,
} from './types.ts';

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

function stronger(left: DetectOutcome, right: DetectOutcome | 'ignore'): DetectOutcome {
  if (right === 'ignore') return left;
  return STRENGTH.indexOf(right) > STRENGTH.indexOf(left) ? right : left;
}

/** Each sensitive group alone, for a scan that reads one detector at a time. */
const ONLY: Readonly<Record<keyof SensitiveGroups, SensitiveGroups>> = recordOf(
  SENSITIVE_GROUPS,
  (group) => recordOf(SENSITIVE_GROUPS, (other) => other === group),
);

/**
 * What of the turn the detectors of what is the profile's own read: the canary it planted, whether
 * the model was given it besides, the private stretches of its system instruction, and the URLs
 * the model was given. A detector whose part is absent reads without it: `canary_leak` and
 * `prompt_leak` find nothing, and to `ungiven_images` and `ungiven_links` no URL was given.
 */
interface DetectScope extends LeakScope, Pick<GuardrailContext, 'givenUrls'> {
  /** The words of the profile's own canary note, when its lexicon rewords it (`boundaryNote`). */
  note?: string;
  /** What `ungiven_images` and `ungiven_links` let through besides the given URLs. */
  allow?: ResolvedAllow;
}

const NO_SCOPE: DetectScope = {};

/**
 * The {@linkcode LeakScope} of a turn under `detect`: each part only while its detector is above
 * `ignore` somewhere, so a profile that reads for neither binds nothing to read for.
 */
function leakScopeOf(detect: ResolvedDetect, turn: LeakScope): LeakScope {
  const canary = detects(detect, 'canary_leak') ? turn.canary : undefined;
  const guarded = detects(detect, 'prompt_leak') && turn.privateSystem?.length;
  return {
    ...(canary ? { canary } : {}),
    ...(canary && turn.canaryGiven ? { canaryGiven: true } : {}),
    ...(guarded ? { privateSystem: turn.privateSystem } : {}),
  };
}

/** The {@linkcode DetectScope} of a turn under `policy`: each part only while a detector reads it. */
function scopeOf(
  policy: Pick<ResolvedGuardrailPolicy, 'detect' | 'allow'>,
  turn: LeakScope & Pick<GuardrailContext, 'givenUrls' | 'lexicon'>,
): DetectScope {
  const { detect } = policy;
  const leaks = leakScopeOf(detect, turn);
  const urls = detects(detect, 'ungiven_images') || detects(detect, 'ungiven_links');
  const note = detects(detect, 'marker_leak')
    ? boundaryNote({ canary: leaks.canary, lexicon: turn.lexicon })
    : undefined;
  return {
    ...leaks,
    ...(urls && turn.givenUrls ? { givenUrls: turn.givenUrls } : {}),
    ...(urls ? { allow: policy.allow } : {}),
    ...(note ? { note } : {}),
  };
}

/** The detectors a stream gate reads itself, as the text grows. */
const SCOPED = ['canary_leak', 'prompt_leak'] as const satisfies readonly Detector[];

function isScoped(detector: Detector): detector is (typeof SCOPED)[number] {
  return (SCOPED as readonly Detector[]).includes(detector);
}

function ranged(ranges: readonly [number, number][], kind: RedactSpan['kind']): RedactSpan[] {
  return ranges.map(([start, end]) => ({ start, end, kind }));
}

/** What `detector` lets through in a turn of `scope`. */
function urlScope(detector: UrlDetector, scope: DetectScope): UrlScope {
  return { ...scope.allow?.[detector], ...(scope.givenUrls ? { given: scope.givenUrls } : {}) };
}

const MARKERS = new RegExp(SYSTEM_BOUNDARY.source, 'gi');

/** With `skipImages`, `ungiven_links` leaves an image's own markup to `ungiven_images`. */
function spansOf(
  detector: Detector,
  text: string,
  scope: DetectScope,
  skipImages = false,
): RedactSpan[] {
  if (detector === 'injection') return injectionSpans(text);
  if (detector === 'marker_leak') {
    const patterns = [MARKERS, ...(scope.note ? [notePattern(scope.note)] : [])];
    return spansFromPatterns(text, patterns, 'prompt');
  }
  if (detector === 'ungiven_images') {
    const spans = imageLeakSpans(text, urlScope(detector, scope));
    return spans.map((span) => ({ ...span, kind: 'image' }));
  }
  if (detector === 'ungiven_links') {
    const spans = linkLeakSpans(text, urlScope(detector, scope), skipImages);
    return spans.map((span) => ({ ...span, kind: 'link' }));
  }
  if (detector === 'canary_leak') {
    const { canary, canaryGiven } = scope;
    return canary && !canaryGiven ? ranged(canaryLeakRanges(text, canary), 'canary') : [];
  }
  if (detector === 'prompt_leak') {
    const { privateSystem, canary } = scope;
    return privateSystem ? ranged(promptEchoRanges(text, privateSystem, canary), 'prompt') : [];
  }
  return sensitiveSpans(text, ONLY[detector]);
}

/** The hit for a match of `detector`. One of ours never carries what it matched. */
function hitOf(detector: Detector, text: string, span: RedactSpan): GuardrailHit {
  const { start, end } = span;
  if (detector === 'canary_leak') return { ...CANARY_HIT, span: { start, end } };
  if (detector === 'prompt_leak') return { ...PROMPT_ECHO_HIT, span: { start, end } };
  return hitFromSpan(text, span, DETECT_RULES[detector], 'high');
}

/** Whether `detector` leaves an image to `ungiven_images`, read at `boundary` beside it. */
function leavesImages(detector: Detector, boundary: Boundary, detect: ResolvedDetect): boolean {
  return detector === 'ungiven_links' && detect.ungiven_images[boundary] !== 'ignore';
}

/** Reads `text` as it crosses `boundary` under the profile's resolved matrix. */
function detectAt(
  text: string,
  boundary: Boundary,
  detect: ResolvedDetect,
  scope: DetectScope = NO_SCOPE,
): Detection {
  const hits: GuardrailHit[] = [];
  const redact: RedactSpan[] = [];
  let action: DetectOutcome = 'allow';
  for (const detector of DETECTORS) {
    const chosen = detect[detector][boundary];
    if (chosen === 'ignore') continue;
    const spans = spansOf(detector, text, scope, leavesImages(detector, boundary, detect));
    if (spans.length === 0) continue;
    for (const span of spans) hits.push(hitOf(detector, text, span));
    if (chosen === 'redact') redact.push(...spans);
    action = stronger(action, chosen);
  }
  if (action === 'block') return { action, hits };
  if (redact.length === 0) return { action, text, hits };
  const replaced = applySpans(text, redact);
  // why: Replacing a match can join what was around it into a new one: that text does not cross.
  if (leftAfterRedact(replaced, boundary, detect, scope)) return { action: 'block', hits };
  return { action, text: replaced, hits };
}

/**
 * Whether `replaced`, a text whose matches were replaced, still holds a match of a detector set
 * to `redact` or `block` at `boundary`, among `detectors`.
 */
function leftAfterRedact(
  replaced: string,
  boundary: Boundary,
  detect: ResolvedDetect,
  scope: DetectScope,
  detectors: readonly Detector[] = DETECTORS,
): boolean {
  return detectors.some((detector) => {
    const chosen = detect[detector][boundary];
    if (chosen !== 'redact' && chosen !== 'block') return false;
    const skip = leavesImages(detector, boundary, detect);
    return spansOf(detector, replaced, scope, skip).length > 0;
  });
}

/** The detectors that read `boundary`: every one not set to `ignore`. */
function detectorsAt(boundary: Boundary, detect: ResolvedDetect): Detector[] {
  return DETECTORS.filter((detector) => detect[detector][boundary] !== 'ignore');
}

/** Whether `scope` holds the part `detector` reads for. One that reads no scope always has its part. */
function hasPart(detector: Detector, scope: DetectScope): boolean {
  if (detector === 'canary_leak') return Boolean(scope.canary);
  if (detector === 'prompt_leak') return Boolean(scope.privateSystem?.length);
  return true;
}

/**
 * Whether any detector reads one of `boundaries`. Given the turn's `scope`, a
 * detector whose part is absent does not count: it has nothing to find.
 */
function detectReads(
  boundaries: readonly Boundary[],
  detect: ResolvedDetect,
  scope?: DetectScope,
): boolean {
  return boundaries.some((boundary) =>
    detectorsAt(boundary, detect).some((detector) => !scope || hasPart(detector, scope)),
  );
}

/** A stretch of streamed text released at a boundary, and how much of the stretch it covers. */
interface Release extends Detection {
  taken: number;
}

/** A stretch of a streamed text, and the detectors the stream settled a match of inside it. */
interface Stretch {
  from: number;
  to: number;
  settled: readonly Detector[];
}

/** What a stream reads a released stretch for: its detectors, in a turn of `scope`. */
interface StreamRead {
  detectors: readonly Detector[];
  scope: DetectScope;
}

/**
 * Reads the stretch `[from, to)` of `window`, a text released as it streams. A match is reported
 * with the stretch it starts in. One being replaced is released whole: `to` is pulled back to its
 * start when the stretch would cut it, and `taken` is how far the release got. A detector set to
 * `block` that the stream settled a match of blocks even when this reading finds none: the two
 * are then out of step, and the stream's finding stands.
 */
function detectRelease(
  window: string,
  { from, to, settled }: Stretch,
  boundary: Boundary,
  detect: ResolvedDetect,
  { detectors, scope }: StreamRead,
): Release {
  const found = detectors.flatMap((detector) =>
    spansOf(detector, window, scope, leavesImages(detector, boundary, detect))
      .filter((span) => span.end > from && span.start < to)
      .map((span) => ({ span, detector, chosen: detect[detector][boundary] })),
  );
  const hitOf = ({ span, detector }: (typeof found)[number]): GuardrailHit =>
    hitFromSpan(window, span, DETECT_RULES[detector], 'high');
  const blocking = found.filter(({ chosen }) => chosen === 'block');
  if (blocking.length > 0) return { action: 'block', hits: blocking.map(hitOf), taken: 0 };
  const unread = settled.filter((detector) => detect[detector][boundary] === 'block');
  if (unread.length > 0) {
    const hits = unread.map(
      (detector): GuardrailHit => ({ rule: DETECT_RULES[detector], severity: 'high' }),
    );
    return { action: 'block', hits, taken: 0 };
  }
  const replaced = found.filter(({ chosen }) => chosen === 'redact');
  let end = to;
  for (;;) {
    const cut = replaced.find(({ span }) => span.start < end && span.end > end);
    if (!cut) break;
    end = Math.max(from, cut.span.start);
  }
  const inside = found.filter(({ span, chosen }) =>
    chosen === 'redact' ? span.end <= end : span.start >= from && span.start < end,
  );
  const spans = inside
    .filter(({ chosen }) => chosen === 'redact')
    .map(({ span }) => ({ ...span, start: Math.max(0, span.start - from), end: span.end - from }));
  const text = applySpans(window.slice(from, end), spans);
  if (spans.length > 0 && leftAfterRedact(text, boundary, detect, scope, detectors)) {
    return { action: 'block', hits: inside.map(hitOf), taken: 0 };
  }
  return {
    action: inside.reduce<DetectOutcome>((action, { chosen }) => stronger(action, chosen), 'allow'),
    text,
    hits: inside.map(hitOf),
    taken: end - from,
  };
}

/** `text` with every match of `detectors` replaced by its placeholder, whatever a profile sets. */
function redactDetectors(text: string, detectors: readonly Detector[]): string {
  return applySpans(
    text,
    detectors.flatMap((detector) => spansOf(detector, text, NO_SCOPE)),
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

/**
 * The guardrail event for what was found at a boundary, or `undefined` when nothing matched.
 * `stage` is the boundary's own unless the text was read as it streamed.
 */
function detectEvent(
  boundary: Boundary,
  found: Pick<Detection, 'action' | 'hits'>,
  provenance?: Provenance,
  stage: GuardrailStage = BOUNDARY_STAGE[boundary],
): GuardrailEvent | undefined {
  if (found.action === 'allow') return undefined;
  return {
    stage,
    boundary,
    trust: trustAt(boundary),
    action: found.action,
    hits: found.hits,
    ...(provenance ? { provenance } : {}),
  };
}

export type { BoundaryReader, Detection, DetectOutcome, DetectScope, Release, StreamRead, Stretch };
export {
  boundaryReader,
  detectAt,
  detectEvent,
  detectorsAt,
  detectReads,
  detectRelease,
  isScoped,
  leakScopeOf,
  redactDetectors,
  scopeOf,
  stronger,
};
