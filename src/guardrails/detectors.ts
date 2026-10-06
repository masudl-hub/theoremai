// invariant: Imports the boundary vocabulary and the sensitive groups only: nothing from
// `src/guardrails/types.ts` or `src/kernel/`, so `types.ts` can read these types without a cycle.

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
import { SENSITIVE_GROUPS } from './sensitive.ts';

/**
 * What the kernel finds in text: the four families of sensitive data, prompt-injection phrasing,
 * and what is the profile's own on its way out (the canary token, the system instruction, the
 * kernel's markers, and an image or link to an address the model was not given).
 */
const DETECTORS = [
  ...SENSITIVE_GROUPS,
  'injection',
  'canary_leak',
  'prompt_leak',
  'marker_leak',
  'ungiven_images',
  'ungiven_links',
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

/** A detector's setting in full. */
interface DetectorConfig {
  /** The action at every boundary. Left out, each boundary keeps its default. */
  action?: DetectAction;
  /** An action for the boundaries it names, over `action` or the default. */
  at?: Partial<Record<Boundary, DetectAction>>;
  /** `ungiven_images` and `ungiven_links` only: the addresses let through besides the given ones. */
  allow?: UrlAllow;
}

/** One action at every boundary, or the setting in full. */
type DetectorRule = DetectAction | DetectorConfig;

/** One action for every detector at every boundary, or a rule for the detectors it names. */
type DetectSpec = DetectAction | Partial<Record<Detector, DetectorRule>>;

/** Every detector's action at every boundary, defaults applied. */
type ResolvedDetect = Readonly<Record<Detector, Readonly<Record<Boundary, DetectAction>>>>;

/** How a detector, a group or an action is named and described to a builder. */
interface DetectMeta {
  label: string;
  doc: string;
}

/** The groups an editor lists detectors under, in order. */
const DETECTOR_GROUPS = ['data', 'attacks', 'ours'] as const;
/** One of {@linkcode DETECTOR_GROUPS}. */
type DetectorGroup = (typeof DETECTOR_GROUPS)[number];

/** The label of every group, and what its detectors find. */
const DETECTOR_GROUP_META: Readonly<Record<DetectorGroup, DetectMeta>> = {
  data: { label: 'Data', doc: 'Sensitive data, whoever wrote it.' },
  attacks: { label: 'Attacks', doc: 'Text written to steer the model.' },
  ours: {
    label: 'Ours',
    doc: "What the model writes that is the profile's own, or that would send data out: the canary, the system instruction, the kernel's markers, and images and links to addresses the model was not given.",
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
  defaults: Readonly<Partial<Record<Boundary, DetectAction>>>;
  /** Whether its setting takes `allow`. */
  allow?: true;
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
  },
  financial: {
    label: 'Financial',
    doc: 'IBANs and card numbers.',
    group: 'data',
    defaults: everywhere('flag'),
  },
  network: {
    label: 'Network',
    doc: 'IPv4 and IPv6 addresses.',
    group: 'data',
    defaults: everywhere('flag'),
  },
  credentials: {
    label: 'Credentials',
    doc: 'API keys and tokens in the formats gitleaks knows (AWS, Google, OpenAI, Anthropic, GitHub, Slack and Stripe among them), key and password assignments, OpenRouter keys, bearer tokens and PEM private keys.',
    group: 'data',
    defaults: everywhere('flag'),
  },
  injection: {
    label: 'Injection',
    doc: 'Prompt-injection phrasing, as written or disguised.',
    group: 'attacks',
    defaults: everywhere('ignore'),
  },
  canary_leak: {
    label: 'Canary leak',
    doc: 'The token the kernel plants in the system instruction, as written or encoded. The token is planted only while this is above Ignore somewhere.',
    group: 'ours',
    defaults: leaving('block', 'block', 'redact'),
  },
  prompt_leak: {
    label: 'Prompt leak',
    doc: 'A run of words from the private system instruction, also reversed, in rot13 or in leetspeak.',
    group: 'ours',
    defaults: leaving('flag', 'block', 'redact'),
  },
  marker_leak: {
    label: 'Marker leak',
    doc: 'The markers the kernel fences user data with, and the words of the note that binds the canary.',
    group: 'ours',
    defaults: shown('block', 'redact'),
  },
  ungiven_images: {
    label: 'Ungiven images',
    doc: 'An image whose address the model was not given, on a host not allowed. Showing it loads the address, which can carry data out with no click.',
    group: 'ours',
    defaults: shown('block', 'redact'),
    allow: true,
  },
  ungiven_links: {
    label: 'Ungiven links',
    doc: 'A link to an address the model was not given, on a host not allowed. It loads on a click, or where the host unfurls links into previews; replies cite pages from what the model knows, so it starts at Ignore.',
    group: 'ours',
    defaults: shown('ignore', 'ignore'),
    allow: true,
  },
};

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
  const { action, at } = rule;
  return { ...(action === undefined ? base : wherever(detector, action)), ...at };
}

/** `spec` with everything it leaves out at its default. */
function resolveDetect(spec?: DetectSpec): ResolvedDetect {
  if (spec === undefined) return DETECT_DEFAULTS;
  if (isAction(spec)) return recordOf(DETECTORS, (detector) => wherever(detector, spec));
  return recordOf(DETECTORS, (detector) => resolveRule(detector, spec[detector]));
}

/** The detectors whose setting takes `allow`. */
type UrlDetector = 'ungiven_images' | 'ungiven_links';

/** What each of the {@linkcode UrlDetector}s lets through, as the profile set it. */
type ResolvedAllow = Readonly<Record<UrlDetector, UrlAllow>>;

const NO_ALLOW: ResolvedAllow = { ungiven_images: {}, ungiven_links: {} };

function allowOf(rule: DetectorRule | undefined): UrlAllow {
  return (isAction(rule) ? undefined : rule?.allow) ?? {};
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

function atProblem(
  path: string,
  at: unknown,
  detector: Detector,
  boundaries: readonly Boundary[],
): string | undefined {
  if (at === undefined) return undefined;
  if (!isRecord(at)) return `${path} must be an object of boundaries`;
  const known = new Set<string>(boundaries);
  const applies = DETECTOR_BOUNDARIES[detector];
  for (const [boundary, action] of Object.entries(at)) {
    if (!known.has(boundary)) {
      return `${path}.${boundary} is not a boundary this profile has (${boundaries.join(', ')})`;
    }
    if (!(applies as readonly string[]).includes(boundary)) {
      return `${path}.${boundary} is not a boundary ${detector} applies at (${applies.join(', ')})`;
    }
    if (!isAction(action)) return `${path}.${boundary} must be one of ${ACTION_LIST}`;
  }
  return undefined;
}

const CONFIG_KEYS: readonly string[] = ['action', 'at', 'allow'] satisfies (keyof DetectorConfig)[];
const ALLOW_KEYS: readonly string[] = ['hosts', 'fromTools'] satisfies (keyof UrlAllow)[];

/** A hostname is all an allowed host is: a scheme, port or path would never match one. */
function allowProblem(path: string, allow: unknown, detector: Detector): string | undefined {
  if (allow === undefined) return undefined;
  if (!DETECTOR_META[detector].allow) {
    return `${path} is a setting of ungiven_images and ungiven_links only`;
  }
  if (!isRecord(allow)) return `${path} must be an object`;
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
    atProblem(`${path}.at`, rule.at, detector, boundaries) ??
    allowProblem(`${path}.allow`, rule.allow, detector)
  );
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
    if (!isDetector(detector)) {
      return `${path}.${detector} is not a detector (${DETECTORS.join(', ')})`;
    }
    const problem = ruleProblem(`${path}.${detector}`, rule, detector, boundaries);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

export type {
  DetectAction,
  DetectMeta,
  Detector,
  DetectorConfig,
  DetectorDeclaration,
  DetectorGroup,
  DetectorRule,
  DetectSpec,
  ResolvedAllow,
  ResolvedDetect,
  UrlAllow,
  UrlDetector,
};
export {
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
  NO_ALLOW,
  resolveAllow,
  resolveDetect,
};
