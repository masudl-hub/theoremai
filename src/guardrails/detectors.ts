// invariant: Imports the boundary vocabulary, the sensitive groups and the host's patterns only:
// nothing from `src/guardrails/types.ts` or `src/kernel/`, so `types.ts` can read these types
// without a cycle.

/** lexicon-exempt-file: authoring labels, descriptions and profile-registration diagnostics for detectors — not runtime user or model copy (P2) */

import {
  BOUNDARIES,
  type Boundary,
  INBOUND_BOUNDARIES,
  OUTBOUND_BOUNDARIES,
  recordOf,
  TOOL_BOUNDARIES,
  TOOL_KINDS,
  toolBoundary,
} from './boundaries.ts';
import {
  type CompiledPatterns,
  type HostMatcher,
  type HostPattern,
  matchersOf,
  patternsProblem,
} from './host-patterns.ts';
import { SENSITIVE_GROUPS } from './sensitive.ts';

/**
 * What the kernel finds in text: the four families of sensitive data, prompt-injection phrasing,
 * a tool's text that instructs the agent, and what is the profile's own on its way out (the canary token, the system instruction, the
 * kernel's markers, an image or link to an address the model was not given, and the names of its
 * tools).
 */
const DETECTORS = [
  ...SENSITIVE_GROUPS,
  'injection',
  'tool_instructions',
  'canary_leak',
  'prompt_leak',
  'marker_leak',
  'ungiven_images',
  'ungiven_links',
  'tool_leak',
] as const;
/** One of {@linkcode DETECTORS}. */
type Detector = (typeof DETECTORS)[number];

/**
 * What the kernel does with a match, the same at every boundary:
 * - `ignore` — the text is not checked.
 * - `flag` — the match is recorded in the trace; nothing changes.
 * - `redact` — the match is replaced with a placeholder; the rest is kept.
 * - `block` — the whole message, reply or tool call is stopped.
 */
const DETECT_ACTIONS = ['ignore', 'flag', 'redact', 'block'] as const;
/** One of {@linkcode DETECT_ACTIONS}. */
type DetectAction = (typeof DETECT_ACTIONS)[number];

/** The addresses `ungiven_images` or `ungiven_links` lets through beyond the ones the model was given. */
interface UrlAllow {
  /** Hostnames let through whatever their URL, such as the host's own CDN. */
  hosts?: readonly string[];
  /**
   * Whether a URL a tool returned counts as given. Default true. A tool result can offer the
   * model URLs to pick from, and the pick tells their server something; false closes that
   * channel, and keeps only what the system prompt, the user and host history gave.
   */
  fromTools?: boolean;
}

/** The names `tool_leak` lets through. */
interface NameAllow {
  /** Names of tools or parameters that are innocent in a reply, such as a tool called `search`. */
  names?: readonly string[];
}

/** A detector's setting in full. */
interface DetectorConfig {
  /** The action at every boundary. Left out, each boundary keeps its default. */
  action?: DetectAction;
  /** An action for the boundaries it names, over `action` or the default. */
  at?: Partial<Record<Boundary, DetectAction>>;
  /**
   * Whether Theorem's own patterns run. Default true. With `patterns` it gives the four choices:
   * both, only Theorem's, only the host's (`false` with patterns), or none (`false` without).
   * A detector that takes no patterns refuses it.
   */
  theorem?: boolean;
  /** The host's own patterns, read on the text as written. A detector that takes no patterns refuses them. */
  patterns?: readonly HostPattern[];
  /** The table compiled for `patterns` (`compilePatterns`, `agents detect-compile`). Patterns need it. */
  compiled?: CompiledPatterns;
  /**
   * One line telling the model what to leave out, sent when this detector blocks a reply that is
   * then retried. Left out, the lexicon's `detect.hint.<detector>`. Only beside `patterns`: the
   * lexicon's hint describes Theorem's patterns, not the host's.
   */
  hint?: string;
  /**
   * What the detector lets through: for `ungiven_images` and `ungiven_links` the addresses besides
   * the given ones, for `tool_leak` the names that are innocent. Any other detector refuses it.
   */
  allow?: UrlAllow | NameAllow;
}

/** One action at every boundary, or the setting in full. */
type DetectorRule = DetectAction | DetectorConfig;

/** The key of a detector of the host's own: its namespace, a dot, a name (`acme.record`). */
type HostDetectorId = `${string}.${string}`;

/** A stretch of the text a host's `find` matched: `[start, end)`, in UTF-16 units. */
interface HostSpan {
  start: number;
  end: number;
}

/**
 * A host's own reading of a text, for what patterns cannot say. It runs on every text crossing a
 * boundary the detector reads, so it returns at once and does not wait on anything. If it throws,
 * or returns a span outside the text, the text does not cross. It also reads the text a trace
 * stores, where there is no `boundary`; a text it fails on there is stored as a placeholder.
 */
type HostFind = (text: string, context: { boundary?: Boundary }) => readonly HostSpan[];

/**
 * A detector of the host's own, under a key with a dot. It reads with `patterns`, `find` or both,
 * and has no default: it reads the boundaries `action` and `at` put above `ignore`.
 */
interface HostDetectorConfig {
  /** What an editor and the trace call it. */
  label: string;
  /** The action at every boundary. Left out, only the boundaries `at` names are read. */
  action?: DetectAction;
  /** An action for the boundaries it names, over `action`. */
  at?: Partial<Record<Boundary, DetectAction>>;
  /** Its patterns, read on the text as written. */
  patterns?: readonly HostPattern[];
  /** The table compiled for `patterns` (`compilePatterns`, `agents detect-compile`). Patterns need it. */
  compiled?: CompiledPatterns;
  /**
   * Its own reading. As a reply streams, a `find` reads the text held so far, and the last
   * `HOST_FIND_HOLD` characters stay held (`HOST_FIND_HOLD_LIVE` in a Live reply): a match is
   * caught whole when it is no longer than that.
   */
  find?: HostFind;
  /**
   * One line telling the model what to leave out, sent when this detector blocks a reply that is
   * then retried. Left out, the lexicon's `detect.hint.own`, which names the label.
   */
  hint?: string;
}

/** One action for every detector at every boundary, or a rule for the detectors it names. */
type DetectSpec =
  | DetectAction
  | (Partial<Record<Detector, DetectorRule>> & {
      readonly [id: HostDetectorId]: HostDetectorConfig;
    });

/** A host's detector, resolved: its action at every boundary and what it reads with. */
interface HostDetector {
  id: HostDetectorId;
  label: string;
  actions: Readonly<Record<Boundary, DetectAction>>;
  /** Its patterns, ready to run. */
  matchers: readonly HostMatcher[];
  /** The table compiled for its patterns; absent when it has none. */
  compiled?: CompiledPatterns;
  find?: HostFind;
  hint?: string;
}

/** How much of a streaming reply stays held for a host's `find`, in characters. */
const HOST_FIND_HOLD = 256;
/** The same in a Live reply, which is spoken as it is written. */
const HOST_FIND_HOLD_LIVE = 96;

/** Whose patterns a detector reads with: Theorem's, the host's, both or neither. */
interface DetectorSource {
  /** Whether Theorem's own patterns run. */
  theorem: boolean;
  /** The host's patterns, ready to run. */
  matchers: readonly HostMatcher[];
  /** The table compiled for the host's patterns; absent when it has none. */
  compiled?: CompiledPatterns;
}

/** The source of each detector a profile changed it for. One left out reads with Theorem's patterns only. */
type DetectSources = Readonly<Partial<Record<Detector, DetectorSource>>>;

/** Every detector's action at every boundary. */
type DetectMatrix = Readonly<Record<Detector, Readonly<Record<Boundary, DetectAction>>>>;

/**
 * Every detector's action at every boundary, defaults applied, and whose patterns each reads
 * with. A detector left with no patterns at all is `ignore` everywhere: it has nothing to find.
 */
type ResolvedDetect = DetectMatrix & {
  readonly sources?: DetectSources;
  /** The hint of each of Theorem's detectors the profile set one on. */
  readonly hints?: Readonly<Partial<Record<Detector, string>>>;
  /** The names `tool_leak` lets through. */
  readonly innocent?: readonly string[];
  /** The host's own detectors, in the order the profile lists them. */
  readonly host?: readonly HostDetector[];
};

/** How a detector, a group or an action is named and described to a builder. */
interface DetectMeta {
  label: string;
  doc: string;
}

/** The groups an editor lists detectors under, in order. */
const DETECTOR_GROUPS = ['data', 'manipulation', 'setup', 'addresses'] as const;
/** One of {@linkcode DETECTOR_GROUPS}. */
type DetectorGroup = (typeof DETECTOR_GROUPS)[number];

/** The label of every group, and what its detectors find. */
const DETECTOR_GROUP_META: Readonly<Record<DetectorGroup, DetectMeta>> = {
  data: { label: 'Sensitive data', doc: 'Personal and secret data.' },
  manipulation: { label: 'Manipulation', doc: 'Text that steers the agent.' },
  setup: {
    label: 'Agent setup',
    doc: "The profile's own text in model output.",
  },
  addresses: {
    label: 'Unknown addresses',
    doc: 'Addresses the model was not given.',
  },
};

type BoundaryActions = Readonly<Partial<Record<Boundary, DetectAction>>>;

/**
 * Everything that describes a detector: what it finds, its group, and its default action at each
 * boundary it applies at. The default is also the recommended action. A boundary left out is one
 * the detector does not apply at.
 */
interface DetectorDeclaration extends DetectMeta {
  group: DetectorGroup;
  /** Its name in a list under its group's name, where the group says the rest. */
  short?: string;
  defaults: Readonly<Partial<Record<Boundary, DetectAction>>>;
  /** What its setting's `allow` lists, when it takes one: addresses, or names. */
  allow?: 'urls' | 'names';
  /** Whether it reads with patterns, so its setting takes `theorem` and `patterns`. */
  patterns?: true;
}

const TOOL_ARGUMENT_BOUNDARIES = TOOL_KINDS.map((kind) => toolBoundary('tool_arguments', kind));

/** Text on its way to the model is redacted, a tool call takes `toTool`, and what the model writes is not read. */
function everywhere(toTool: DetectAction): BoundaryActions {
  return {
    ...recordOf(INBOUND_BOUNDARIES, () => 'redact' as const),
    ...recordOf(TOOL_BOUNDARIES, () => 'redact' as const),
    ...recordOf(TOOL_ARGUMENT_BOUNDARIES, () => toTool),
    ...recordOf(OUTBOUND_BOUNDARIES, () => 'ignore' as const),
  };
}

/** What the model writes: a tool call takes `toTool`, what it says takes `said`, a thought `thought`. */
function leaving(toTool: DetectAction, said: DetectAction, thought: DetectAction): BoundaryActions {
  return {
    ...recordOf(TOOL_ARGUMENT_BOUNDARIES, () => toTool),
    reply: said,
    reply_structured: said,
    live_reply: said,
    thought,
  };
}

/** What a tool returns, its output and its error text: `remote` from a tool the host did not write, `local` from a function. */
function returned(remote: DetectAction, local: DetectAction): BoundaryActions {
  const crossings = ['tool_output', 'tool_failure'] as const;
  return Object.fromEntries(
    crossings.flatMap((crossing) =>
      TOOL_KINDS.map((kind) => [
        toolBoundary(crossing, kind),
        kind === 'function' ? local : remote,
      ]),
    ),
  );
}

/** What the model says or thinks: a reply of any kind takes `said`, a thought `thought`. */
function shown(said: DetectAction, thought: DetectAction): BoundaryActions {
  return { reply: said, reply_structured: said, live_reply: said, thought };
}

/** Every detector's declaration. The editor, validation and the catalog are built from it. */
const DETECTOR_META: Readonly<Record<Detector, DetectorDeclaration>> = {
  ids: {
    label: 'IDs',
    doc: 'US SSN, ITIN and EIN numbers.',
    group: 'data',
    defaults: everywhere('flag'),
    patterns: true,
  },
  financial: {
    label: 'Financial',
    doc: 'IBANs and card numbers.',
    group: 'data',
    defaults: everywhere('flag'),
    patterns: true,
  },
  network: {
    label: 'Network',
    doc: 'IPv4 and IPv6 addresses.',
    group: 'data',
    defaults: everywhere('flag'),
    patterns: true,
  },
  credentials: {
    label: 'Credentials',
    doc: 'API keys, tokens, passwords and private keys.',
    group: 'data',
    defaults: everywhere('flag'),
    patterns: true,
  },
  injection: {
    label: 'Injection',
    doc: 'Prompt-injection phrasing, plain or disguised.',
    group: 'manipulation',
    defaults: everywhere('ignore'),
    patterns: true,
  },
  tool_instructions: {
    label: 'Tool instructions',
    short: 'From tools',
    doc: 'Tool output that instructs the agent. A match raises taint.',
    group: 'manipulation',
    defaults: returned('flag', 'ignore'),
    patterns: true,
  },
  canary_leak: {
    label: 'Canary leak',
    doc: 'The canary token, plain or encoded. Planted only above Ignore.',
    group: 'setup',
    defaults: leaving('block', 'block', 'redact'),
  },
  prompt_leak: {
    label: 'Prompt leak',
    doc: 'Private system-instruction text, plain or disguised.',
    group: 'setup',
    defaults: leaving('flag', 'block', 'redact'),
  },
  marker_leak: {
    label: 'Marker leak',
    doc: "The kernel's data markers and canary note.",
    group: 'setup',
    defaults: shown('block', 'redact'),
  },
  ungiven_images: {
    label: 'Ungiven images',
    short: 'Images',
    doc: 'An image at an address not given. Loads with no click.',
    group: 'addresses',
    defaults: shown('block', 'redact'),
    allow: 'urls',
  },
  ungiven_links: {
    label: 'Ungiven links',
    short: 'Links',
    doc: 'A link to an address not given. Replies cite known pages, so it is not checked by default.',
    group: 'addresses',
    defaults: shown('ignore', 'ignore'),
    allow: 'urls',
  },
  tool_leak: {
    label: 'Tool leak',
    doc: "The profile's tool and parameter names.",
    group: 'setup',
    defaults: shown('flag', 'flag'),
    allow: 'names',
    patterns: true,
  },
};

/** The detectors that read with patterns: their setting takes `theorem` and `patterns`. */
const PATTERN_DETECTORS: readonly Detector[] = DETECTORS.filter(
  (detector) => DETECTOR_META[detector].patterns,
);

/** The boundaries each detector applies at, in the kernel's order. */
const DETECTOR_BOUNDARIES: Readonly<Record<Detector, readonly Boundary[]>> = recordOf(
  DETECTORS,
  (detector) => BOUNDARIES.filter((boundary) => boundary in DETECTOR_META[detector].defaults),
);

/** The label of every action, and what it does. */
const DETECT_ACTION_META: Readonly<Record<DetectAction, DetectMeta>> = {
  ignore: { label: 'Ignore', doc: 'Does not check the text.' },
  flag: {
    label: 'Flag',
    doc: 'Records the match in the trace. Changes nothing.',
  },
  redact: {
    label: 'Redact',
    doc: 'Replaces the match with a placeholder. Keeps the rest.',
  },
  block: {
    label: 'Block',
    doc: 'Stops the whole message, reply or tool call. None of it gets through.',
  },
};

/** `action` wherever `detector` applies. Anywhere else it is `ignore`: the detector is not run there. */
function wherever(detector: Detector, action: DetectAction): Record<Boundary, DetectAction> {
  const applies = DETECTOR_META[detector].defaults;
  return recordOf(BOUNDARIES, (boundary) => (boundary in applies ? action : 'ignore'));
}

/** What a profile that sets no `guardrails.detect` gets. */
const DETECT_DEFAULTS: ResolvedDetect = recordOf(DETECTORS, (detector) => ({
  ...wherever(detector, 'ignore'),
  ...DETECTOR_META[detector].defaults,
}));

/** Whether `detector` is above `ignore` at any of `boundaries`. */
function detects(
  detect: ResolvedDetect,
  detector: Detector,
  boundaries: readonly Boundary[] = BOUNDARIES,
): boolean {
  return boundaries.some((boundary) => detect[detector][boundary] !== 'ignore');
}

function isAction(value: unknown): value is DetectAction {
  return (DETECT_ACTIONS as readonly unknown[]).includes(value);
}

function resolveRule(
  detector: Detector,
  rule: DetectorRule | undefined,
): Readonly<Record<Boundary, DetectAction>> {
  const base = DETECT_DEFAULTS[detector];
  if (rule === undefined) return base;
  if (isAction(rule)) return wherever(detector, rule);
  // why: With neither Theorem's patterns nor the host's, the detector has nothing to find.
  const { action, at, theorem = true, patterns = [] } = rule;
  if (!theorem && patterns.length === 0) return wherever(detector, 'ignore');
  return { ...(action === undefined ? base : wherever(detector, action)), ...at };
}

/** Whose patterns `rule` reads with, when it says: `undefined` is Theorem's only. */
function sourceOf(rule: DetectorRule | undefined): DetectorSource | undefined {
  if (rule === undefined || isAction(rule)) return undefined;
  const { theorem = true, patterns = [], compiled } = rule;
  if (theorem && patterns.length === 0) return undefined;
  return {
    theorem,
    matchers: matchersOf(patterns),
    ...(compiled && patterns.length > 0 ? { compiled } : {}),
  };
}

/** `spec` with everything it leaves out at its default. */
function resolveDetect(spec?: DetectSpec): ResolvedDetect {
  if (spec === undefined) return DETECT_DEFAULTS;
  if (isAction(spec)) return recordOf(DETECTORS, (detector) => wherever(detector, spec));
  const matrix = recordOf(DETECTORS, (detector) => resolveRule(detector, spec[detector]));
  const sources: Partial<Record<Detector, DetectorSource>> = {};
  const hints: Partial<Record<Detector, string>> = {};
  for (const detector of PATTERN_DETECTORS) {
    const rule = spec[detector];
    const source = sourceOf(rule);
    if (source) sources[detector] = source;
    if (rule !== undefined && !isAction(rule) && rule.hint) hints[detector] = rule.hint;
  }
  const leak = spec.tool_leak;
  const innocent = isAction(leak) ? undefined : (leak?.allow as NameAllow | undefined)?.names;
  const host = Object.entries(spec).flatMap(([id, rule]) =>
    isHostId(id) ? [hostDetector(id, rule as HostDetectorConfig)] : [],
  );
  return {
    ...matrix,
    ...(Object.keys(sources).length > 0 ? { sources } : {}),
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
    ...(innocent?.length ? { innocent } : {}),
    ...(host.length > 0 ? { host } : {}),
  };
}

function isHostId(key: string): key is HostDetectorId {
  return key.includes('.');
}

function hostDetector(id: HostDetectorId, config: HostDetectorConfig): HostDetector {
  const { label, action = 'ignore', at, patterns = [], compiled, find, hint } = config;
  return {
    id,
    label,
    actions: recordOf(BOUNDARIES, (boundary) => at?.[boundary] ?? action),
    matchers: matchersOf(patterns),
    ...(compiled && patterns.length > 0 ? { compiled } : {}),
    ...(find ? { find } : {}),
    ...(hint ? { hint } : {}),
  };
}

/** The action of `key`, a detector of Theorem's or the host's, at `boundary`. One unknown is `ignore`. */
function actionAt(detect: ResolvedDetect, key: string, boundary: Boundary): DetectAction {
  if (isDetector(key)) return detect[key][boundary];
  return detect.host?.find(({ id }) => id === key)?.actions[boundary] ?? 'ignore';
}

/** The detectors whose setting takes `allow`. */
type UrlDetector = 'ungiven_images' | 'ungiven_links';

/** What each of the {@linkcode UrlDetector}s lets through, as the profile set it. */
type ResolvedAllow = Readonly<Record<UrlDetector, UrlAllow>>;

const NO_ALLOW: ResolvedAllow = { ungiven_images: {}, ungiven_links: {} };

function allowOf(rule: DetectorRule | undefined): UrlAllow {
  return (isAction(rule) ? undefined : (rule?.allow as UrlAllow | undefined)) ?? {};
}

/** The `allow` of each detector that takes one. */
function resolveAllow(spec?: DetectSpec): ResolvedAllow {
  if (spec === undefined || isAction(spec)) return NO_ALLOW;
  const images = allowOf(spec.ungiven_images);
  const links = allowOf(spec.ungiven_links);
  // why: A host images load from already takes data with no click, so a link there opens nothing new.
  const hosts = [...new Set([...(links.hosts ?? []), ...(images.hosts ?? [])])];
  return {
    ungiven_images: images,
    ungiven_links: hosts.length > 0 ? { ...links, hosts } : links,
  };
}

const ACTION_LIST = DETECT_ACTIONS.join(', ');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `detector` left out is one of the host's own, which applies at every boundary. */
function atProblem(
  path: string,
  at: unknown,
  boundaries: readonly Boundary[],
  detector?: Detector,
): string | undefined {
  if (at === undefined) return undefined;
  if (!isRecord(at)) return `${path} must be an object of boundaries`;
  const known = new Set<string>(boundaries);
  const applies: readonly string[] = detector ? DETECTOR_BOUNDARIES[detector] : BOUNDARIES;
  for (const [boundary, action] of Object.entries(at)) {
    if (!known.has(boundary)) {
      return `${path}.${boundary} is not a boundary this profile has (${boundaries.join(', ')})`;
    }
    if (!applies.includes(boundary)) {
      return `${path}.${boundary} is not a boundary ${detector} applies at (${applies.join(', ')})`;
    }
    if (!isAction(action)) return `${path}.${boundary} must be one of ${ACTION_LIST}`;
  }
  return undefined;
}

const CONFIG_KEYS: readonly string[] = [
  'action',
  'at',
  'theorem',
  'patterns',
  'compiled',
  'hint',
  'allow',
] satisfies (keyof DetectorConfig)[];
const SOURCE_KEYS: readonly string[] = [
  'theorem',
  'patterns',
  'compiled',
  'hint',
] satisfies (keyof DetectorConfig)[];
const ALLOW_KEYS: readonly string[] = ['hosts', 'fromTools'] satisfies (keyof UrlAllow)[];

/** The `allow` of `tool_leak`: names, each a string. */
function namesProblem(path: string, allow: Record<string, unknown>): string | undefined {
  const unknown = Object.keys(allow).find((key) => key !== 'names');
  if (unknown !== undefined) return `${path}.${unknown} is not a setting of allow (names)`;
  const { names } = allow;
  if (names === undefined) return undefined;
  if (!Array.isArray(names)) return `${path}.names must be a list`;
  const bad = names.find((name) => typeof name !== 'string' || !name.trim());
  return bad === undefined
    ? undefined
    : `${path}.names lists ${JSON.stringify(bad)}, which is not a name`;
}

/** A hostname is all an allowed host is: a scheme, port or path would never match one. */
function allowProblem(path: string, allow: unknown, detector: Detector): string | undefined {
  if (allow === undefined) return undefined;
  const lists = DETECTOR_META[detector].allow;
  if (!lists) {
    return `${path} is a setting of ungiven_images, ungiven_links and tool_leak only`;
  }
  if (!isRecord(allow)) return `${path} must be an object`;
  if (lists === 'names') return namesProblem(path, allow);
  const unknown = Object.keys(allow).find((key) => !ALLOW_KEYS.includes(key));
  if (unknown !== undefined) {
    return `${path}.${unknown} is not a setting of allow (${ALLOW_KEYS.join(', ')})`;
  }
  const { hosts, fromTools } = allow;
  if (fromTools !== undefined && typeof fromTools !== 'boolean') {
    return `${path}.fromTools must be a boolean`;
  }
  if (hosts === undefined) return undefined;
  if (!Array.isArray(hosts)) return `${path}.hosts must be a list`;
  const bad = hosts.find(
    (host) => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.'),
  );
  return bad === undefined
    ? undefined
    : `${path}.hosts lists ${JSON.stringify(bad)}, which is not a hostname`;
}

function ruleProblem(
  path: string,
  rule: unknown,
  detector: Detector,
  boundaries: readonly Boundary[],
): string | undefined {
  if (isAction(rule)) return undefined;
  if (!isRecord(rule)) return `${path} must be one of ${ACTION_LIST}, or an object`;
  const unknown = Object.keys(rule).find((key) => !CONFIG_KEYS.includes(key));
  if (unknown !== undefined) {
    return `${path}.${unknown} is not a setting of a detector (${CONFIG_KEYS.join(', ')})`;
  }
  if (rule.action !== undefined && !isAction(rule.action)) {
    return `${path}.action must be one of ${ACTION_LIST}`;
  }
  return (
    atProblem(`${path}.at`, rule.at, boundaries, detector) ??
    sourceProblem(path, rule, detector) ??
    allowProblem(`${path}.allow`, rule.allow, detector)
  );
}

/** `theorem`, `patterns` and `compiled`: settings of a detector that reads with patterns. */
function sourceProblem(
  path: string,
  rule: Record<string, unknown>,
  detector: Detector,
): string | undefined {
  if (!DETECTOR_META[detector].patterns) {
    const set = SOURCE_KEYS.find((key) => rule[key] !== undefined);
    return set === undefined
      ? undefined
      : `${path}.${set} is a setting of the detectors that read with patterns only (${PATTERN_DETECTORS.join(', ')})`;
  }
  if (rule.theorem !== undefined && typeof rule.theorem !== 'boolean') {
    return `${path}.theorem must be a boolean`;
  }
  if (rule.hint !== undefined && !(Array.isArray(rule.patterns) && rule.patterns.length > 0)) {
    return `${path}.hint goes beside patterns of your own: without them the lexicon's detect.hint.${detector} is the hint`;
  }
  return (
    hintProblem(`${path}.hint`, rule.hint) ?? patternsProblem(path, rule.patterns, rule.compiled)
  );
}

/** A hint may be this long, in characters: it is a line in the retry, once for each detector that matched. */
const MAX_HINT = 300;

function hintProblem(path: string, hint: unknown): string | undefined {
  if (hint === undefined) return undefined;
  if (typeof hint !== 'string' || !hint.trim()) return `${path} must be a non-empty string`;
  if (hint.includes('\n')) return `${path} must be one line`;
  return hint.length > MAX_HINT ? `${path} must be ${MAX_HINT} characters or fewer` : undefined;
}

function isDetector(value: string): value is Detector {
  return (DETECTORS as readonly string[]).includes(value);
}

/**
 * What is wrong with a `guardrails.detect` value, or `undefined` when it is valid. A misspelt
 * detector or boundary would leave the one it meant at its default, silently, so both are errors.
 * `boundaries` are the ones the profile has; a rule naming another is an error.
 */
function detectProblem(
  path: string,
  spec: unknown,
  boundaries: readonly Boundary[] = BOUNDARIES,
): string | undefined {
  if (spec === undefined || isAction(spec)) return undefined;
  if (!isRecord(spec)) return `${path} must be one of ${ACTION_LIST}, or an object of detectors`;
  for (const [detector, rule] of Object.entries(spec)) {
    const at = `${path}.${detector}`;
    if (!(isDetector(detector) || isHostId(detector))) {
      return `${at} is not a detector (${DETECTORS.join(', ')}), nor one of your own: those have a dot in their key, as in acme.record`;
    }
    const problem = isDetector(detector)
      ? ruleProblem(at, rule, detector, boundaries)
      : hostProblem(at, detector, rule, boundaries);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

const HOST_KEYS: readonly string[] = [
  'label',
  'action',
  'at',
  'patterns',
  'compiled',
  'find',
  'hint',
] satisfies (keyof HostDetectorConfig)[];

/** What is wrong with a detector of the host's own. It has no default, so it says what it reads with and where. */
function hostProblem(
  path: string,
  id: string,
  rule: unknown,
  boundaries: readonly Boundary[],
): string | undefined {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(id)) {
    return `${path}: a detector of your own is keyed namespace.name in lower case, digits and _, as in acme.record`;
  }
  if (!isRecord(rule))
    return `${path} must be an object: a label, an action or at, and patterns or find`;
  const unknown = Object.keys(rule).find((key) => !HOST_KEYS.includes(key));
  if (unknown !== undefined) {
    return `${path}.${unknown} is not a setting of a detector of your own (${HOST_KEYS.join(', ')})`;
  }
  const { label, action, at, patterns, compiled, find, hint } = rule;
  if (typeof label !== 'string' || !label.trim()) return `${path}.label must be a non-empty string`;
  if (action !== undefined && !isAction(action))
    return `${path}.action must be one of ${ACTION_LIST}`;
  if (action === undefined && at === undefined) {
    return `${path} needs an action or at: a detector of your own has no default`;
  }
  if (find !== undefined && typeof find !== 'function') return `${path}.find must be a function`;
  if (patterns === undefined && find === undefined) {
    return `${path} needs patterns or find: it has nothing to read with`;
  }
  return (
    atProblem(`${path}.at`, at, boundaries) ??
    hintProblem(`${path}.hint`, hint) ??
    patternsProblem(path, patterns, compiled)
  );
}

export type {
  DetectAction,
  DetectMatrix,
  DetectMeta,
  Detector,
  DetectorConfig,
  DetectorDeclaration,
  DetectorGroup,
  DetectorRule,
  DetectorSource,
  DetectSources,
  DetectSpec,
  HostDetector,
  HostDetectorConfig,
  HostDetectorId,
  HostFind,
  HostSpan,
  NameAllow,
  ResolvedAllow,
  ResolvedDetect,
  UrlAllow,
  UrlDetector,
};
export {
  actionAt,
  DETECT_ACTION_META,
  DETECT_ACTIONS,
  DETECT_DEFAULTS,
  DETECTOR_BOUNDARIES,
  DETECTOR_GROUP_META,
  DETECTOR_GROUPS,
  DETECTOR_META,
  DETECTORS,
  detectProblem,
  detects,
  HOST_FIND_HOLD,
  HOST_FIND_HOLD_LIVE,
  hintProblem,
  isDetector,
  NO_ALLOW,
  PATTERN_DETECTORS,
  resolveAllow,
  resolveDetect,
};
