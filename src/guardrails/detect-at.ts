// invariant: The one place a match becomes an action. Every boundary calls `detectAt`; nothing
// else reads the matrix to decide what a match does.

import { applySpans, type RedactSpan, spansFromPatterns } from '../observability/spans.ts';
import { type Boundary, recordOf, TOOL_BOUNDARIES } from './boundaries.ts';
import { canaryLeakRanges } from './canary.ts';
import {
  actionAt,
  DETECTORS,
  type DetectAction,
  type Detector,
  type DetectorSource,
  detects,
  type HostDetector,
  type HostFind,
  type ResolvedAllow,
  type ResolvedDetect,
  type UrlDetector,
} from './detectors.ts';
import { boundaryNote, type LeakScope } from './egress.ts';
import { notePattern, SYSTEM_BOUNDARY } from './egress-patterns.ts';
import { imageLeakSpans, linkLeakSpans, type UrlScope } from './egress-urls.ts';
import type { GuardrailEvent, GuardrailHit } from './event-schemas.ts';
import { CANARY_HIT, hitFromSpan, PROMPT_ECHO_HIT } from './hits.ts';
import type { HostMatcher } from './host-patterns.ts';
import { injectionSpans } from './injection.ts';
import { promptEchoRanges } from './prompt-echo.ts';
import { DETECT_RULES, detectRule } from './rules.ts';
import { SENSITIVE_GROUPS, type SensitiveGroups, sensitiveSpans } from './sensitive.ts';
import { directives, mergedRanges } from './tool-directives.ts';
import { ownToolsWithout, toolLeakSpans } from './tool-leak.ts';
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
 * the model was given, and the names of its tools. A detector whose part is absent reads without
 * it: `canary_leak`, `prompt_leak` and `tool_leak` find nothing, and to `ungiven_images` and
 * `ungiven_links` no URL was given.
 */
interface DetectScope extends LeakScope, Pick<GuardrailContext, 'givenUrls' | 'ownTools'> {
  /** The words of the profile's own canary note, when its lexicon rewords it (`boundaryNote`). */
  note?: string;
  /** What `ungiven_images` and `ungiven_links` let through besides the given URLs. */
  allow?: ResolvedAllow;
  /** The tools the model can call this turn, for `tool_instructions`: a tool's text naming one is a match. */
  callable?: readonly string[];
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
  turn: LeakScope & Pick<GuardrailContext, 'givenUrls' | 'lexicon' | 'ownTools'>,
): DetectScope {
  const { detect } = policy;
  const leaks = leakScopeOf(detect, turn);
  const urls = detects(detect, 'ungiven_images') || detects(detect, 'ungiven_links');
  const note = detects(detect, 'marker_leak')
    ? boundaryNote({ canary: leaks.canary, lexicon: turn.lexicon })
    : undefined;
  const tools = detects(detect, 'tool_leak')
    ? ownToolsWithout(turn.ownTools, detect.innocent)
    : undefined;
  return {
    ...leaks,
    ...(urls && turn.givenUrls ? { givenUrls: turn.givenUrls } : {}),
    ...(urls ? { allow: policy.allow } : {}),
    ...(note ? { note } : {}),
    ...(tools ? { ownTools: tools } : {}),
  };
}

/** The detectors a stream gate reads itself, as the text grows. */
const SCOPED = ['canary_leak', 'prompt_leak'] as const satisfies readonly Detector[];

function isScoped(detector: Detector): detector is (typeof SCOPED)[number] {
  return (SCOPED as readonly Detector[]).includes(detector);
}

/** One span for each run of overlapping `ranges`: a passage matched window by window is one match. */
function ranged(ranges: readonly [number, number][], kind: RedactSpan['kind']): RedactSpan[] {
  return mergedRanges(ranges).map(([start, end]) => ({ start, end, kind }));
}

/** What `detector` lets through in a turn of `scope`. */
function urlScope(detector: UrlDetector, scope: DetectScope): UrlScope {
  return { ...scope.allow?.[detector], ...(scope.givenUrls ? { given: scope.givenUrls } : {}) };
}

const MARKERS = new RegExp(SYSTEM_BOUNDARY.source, 'gi');

/** Every match of the host's `matchers` in `text`, each named for its pattern. */
function hostSpans(
  text: string,
  matchers: readonly HostMatcher[],
  kind: RedactSpan['kind'],
): RedactSpan[] {
  return matchers.flatMap(({ name, regex }) =>
    spansFromPatterns(text, [regex], kind).map((span) => ({ ...span, name })),
  );
}

/** The placeholder a host's pattern leaves for a detector, where it is not the sensitive one. */
const HOST_KIND: Readonly<Partial<Record<Detector, RedactSpan['kind']>>> = {
  injection: 'injection',
  tool_instructions: 'directive',
  tool_leak: 'tool',
};

/**
 * What `detector` finds in `text`: with Theorem's patterns, the host's, both or neither, as its
 * `source` says. Left out, Theorem's only. A host's pattern is read on the text as written.
 */
function spansOf(
  detector: Detector,
  text: string,
  scope: DetectScope,
  source?: DetectorSource,
  skipImages = false,
): RedactSpan[] {
  if (!source) return theoremSpans(detector, text, scope, skipImages);
  const own = hostSpans(text, source.matchers, HOST_KIND[detector] ?? 'sensitive');
  return source.theorem ? [...theoremSpans(detector, text, scope, skipImages), ...own] : own;
}

/** With `skipImages`, `ungiven_links` leaves an image's own markup to `ungiven_images`. */
function theoremSpans(
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
  if (detector === 'tool_leak') return toolLeakSpans(text, scope.ownTools);
  if (detector === 'tool_instructions') {
    return directives(text, scope.callable).map((found) => ({ ...found, kind: 'directive' }));
  }
  return sensitiveSpans(text, ONLY[detector]);
}

/** The hit for a match of `detector`. One of ours never carries what it matched. */
function hitOf(detector: Detector, text: string, span: RedactSpan): GuardrailHit {
  const { start, end } = span;
  if (detector === 'canary_leak') return { ...CANARY_HIT, span: { start, end } };
  if (detector === 'prompt_leak') return { ...PROMPT_ECHO_HIT, span: { start, end } };
  if (detector === 'tool_instructions' && span.signal) {
    const severity = span.signal === 'order' || span.signal === 'authority' ? 'medium' : 'high';
    return { ...hitFromSpan(text, span, DETECT_RULES[detector], severity), signal: span.signal };
  }
  return hitFromSpan(text, span, DETECT_RULES[detector], 'high');
}

/** Whether `detector` leaves an image to `ungiven_images`, read at `boundary` beside it. */
function leavesImages(detector: Detector, boundary: Boundary, detect: ResolvedDetect): boolean {
  return detector === 'ungiven_links' && detect.ungiven_images[boundary] !== 'ignore';
}

/** A detector reading one boundary, Theorem's or the host's: both go the same way from here. */
interface Reader {
  /** The detector, or the id of the host's own. */
  key: string;
  rule: string;
  /** What a host called its own detector: its hits carry it, since no catalog names their rule. */
  label?: string;
  chosen: Exclude<DetectAction, 'ignore'>;
  /** Its matches in `text`, or how a host's `find` failed: the text does not cross. */
  spans(text: string): RedactSpan[] | FindFailure;
  hit(text: string, span: RedactSpan): GuardrailHit;
}

/**
 * How a host's `find` failed, as its hit's `signal`: it threw (`find_threw`), or what it
 * returned is not a list of stretches inside the text (`find_result`).
 */
type FindFailure = 'find_threw' | 'find_result';

/** What a host's `find` matched in `text`, or how it failed. */
function foundBy(find: HostFind, text: string, boundary?: Boundary): RedactSpan[] | FindFailure {
  try {
    const spans = find(text, boundary ? { boundary } : {});
    if (!Array.isArray(spans)) return 'find_result';
    const inside = spans.every(
      ({ start, end }) =>
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        start < end &&
        end <= text.length,
    );
    return inside ? spans.map(({ start, end }) => ({ start, end, kind: 'host' })) : 'find_result';
  } catch {
    // why: A reading that failed found nothing it can vouch for, so the text does not cross.
    return 'find_threw';
  }
}

function hostReader(host: HostDetector, boundary: Boundary, chosen: Reader['chosen']): Reader {
  const rule = detectRule(host.id);
  return {
    key: host.id,
    rule,
    label: host.label,
    chosen,
    spans(text) {
      const matched = hostSpans(text, host.matchers, 'host');
      if (!host.find) return matched;
      const found = foundBy(host.find, text, boundary);
      return typeof found === 'string' ? found : [...matched, ...found];
    },
    hit: (text, span) => ({ ...hitFromSpan(text, span, rule, 'high'), label: host.label }),
  };
}

/** The host's own detectors that read `boundary`. */
function hostAt(boundary: Boundary, detect: ResolvedDetect): HostDetector[] {
  return (detect.host ?? []).filter(({ actions }) => actions[boundary] !== 'ignore');
}

/** Every detector that reads `boundary`, Theorem's then the host's; among `keys` when given. */
function readersAt(
  boundary: Boundary,
  detect: ResolvedDetect,
  scope: DetectScope,
  keys?: readonly string[],
): Reader[] {
  const readers: Reader[] = [];
  for (const detector of DETECTORS) {
    const chosen = detect[detector][boundary];
    if (chosen === 'ignore') continue;
    const skip = leavesImages(detector, boundary, detect);
    readers.push({
      key: detector,
      rule: DETECT_RULES[detector],
      chosen,
      spans: (text) => spansOf(detector, text, scope, detect.sources?.[detector], skip),
      hit: (text, span) => hitOf(detector, text, span),
    });
  }
  for (const host of hostAt(boundary, detect)) {
    readers.push(hostReader(host, boundary, host.actions[boundary] as Reader['chosen']));
  }
  return keys ? readers.filter(({ key }) => keys.includes(key)) : readers;
}

/** The hit of a host's `find` that failed: it names the detector, how it failed and no match. */
function failedHit(
  { rule, label }: Pick<Reader, 'rule' | 'label'>,
  signal?: FindFailure,
): GuardrailHit {
  return {
    rule,
    severity: 'high',
    ...(label === undefined ? {} : { label }),
    ...(signal === undefined ? {} : { signal }),
  };
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
  for (const reader of readersAt(boundary, detect, scope)) {
    const spans = reader.spans(text);
    if (typeof spans === 'string') {
      hits.push(failedHit(reader, spans));
      action = 'block';
      continue;
    }
    if (spans.length === 0) continue;
    for (const span of spans) hits.push(reader.hit(text, span));
    if (reader.chosen === 'redact') redact.push(...spans);
    action = stronger(action, reader.chosen);
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
  detectors?: readonly string[],
): boolean {
  return readersAt(boundary, detect, scope, detectors).some(({ chosen, spans }) => {
    if (chosen === 'flag') return false;
    const left = spans(replaced);
    return !left || left.length > 0;
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
  if (detector === 'tool_leak') return Boolean(scope.ownTools?.names.length);
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
  return boundaries.some(
    (boundary) =>
      hostAt(boundary, detect).length > 0 ||
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
  settled: readonly string[];
}

/** What a stream reads a released stretch for: its detectors, Theorem's and the host's, in a turn of `scope`. */
interface StreamRead {
  detectors: readonly string[];
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
  const failed: GuardrailHit[] = [];
  const found = readersAt(boundary, detect, scope, detectors).flatMap((reader) => {
    const spans = reader.spans(window);
    if (typeof spans === 'string') failed.push(failedHit(reader, spans));
    return (typeof spans === 'string' ? [] : spans)
      .filter((span) => span.end > from && span.start < to)
      .map((span) => ({ span, rule: reader.rule, label: reader.label, chosen: reader.chosen }));
  });
  if (failed.length > 0) return { action: 'block', hits: failed, taken: 0 };
  const hitOf = ({ span, rule, label }: (typeof found)[number]): GuardrailHit => ({
    ...hitFromSpan(window, span, rule, 'high'),
    ...(label === undefined ? {} : { label }),
  });
  const blocking = found.filter(({ chosen }) => chosen === 'block');
  if (blocking.length > 0) return { action: 'block', hits: blocking.map(hitOf), taken: 0 };
  const unread = settled.filter((key) => actionAt(detect, key, boundary) === 'block');
  if (unread.length > 0) {
    const hits = unread.map((key) =>
      failedHit({
        rule: detectRule(key),
        label: detect.host?.find(({ id }) => id === key)?.label,
      }),
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

/** Whose patterns clean a stored trace: what the turn reads with (`true`), or the sides named. */
type StoredSides = true | { theorem: boolean; host: boolean };

/**
 * What `detectors` find in a text a trace stores, whatever action a profile sets. `detect` is
 * the profile's, for the patterns a host added to each.
 */
function storedSpans(
  text: string,
  detectors: readonly Detector[],
  sides: StoredSides,
  detect?: ResolvedDetect,
): RedactSpan[] {
  return detectors.flatMap((detector) => {
    const turn = detect?.sources?.[detector];
    const source =
      sides === true
        ? turn
        : { theorem: sides.theorem, matchers: sides.host ? (turn?.matchers ?? []) : [] };
    return spansOf(detector, text, NO_SCOPE, source);
  });
}

/** What a host's own detectors find in a text a trace stores. A `find` that fails covers it all. */
function storedHostSpans(text: string, detect?: ResolvedDetect): RedactSpan[] {
  return (detect?.host ?? []).flatMap((host) => {
    const matched = hostSpans(text, host.matchers, 'host');
    if (!host.find || !text) return matched;
    const found = foundBy(host.find, text);
    return typeof found === 'string'
      ? [{ start: 0, end: text.length, kind: 'host' }]
      : [...matched, ...found];
  });
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

export type {
  BoundaryReader,
  Detection,
  DetectOutcome,
  DetectScope,
  Release,
  StoredSides,
  StreamRead,
  Stretch,
};
export {
  boundaryReader,
  detectAt,
  detectEvent,
  detectorsAt,
  detectReads,
  detectRelease,
  hostAt,
  isScoped,
  leakScopeOf,
  redactDetectors,
  scopeOf,
  storedHostSpans,
  storedSpans,
  stronger,
};
