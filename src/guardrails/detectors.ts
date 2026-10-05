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

/** What the kernel finds in text: the four families of sensitive data, and prompt-injection phrasing. */
const DETECTORS = [...SENSITIVE_GROUPS, 'injection'] as const;
/** One of {@linkcode DETECTORS}. */
type Detector = (typeof DETECTORS)[number];

/**
 * What the kernel does with a match, the same at every boundary:
 * - `ignore` — the text is not read.
 * - `flag` — the match is reported in the trace; the text crosses unchanged.
 * - `redact` — the match is replaced with a placeholder; the rest crosses.
 * - `block` — the thing crossing does not cross.
 */
const DETECT_ACTIONS = ['ignore', 'flag', 'redact', 'block'] as const;
/** One of {@linkcode DETECT_ACTIONS}. */
type DetectAction = (typeof DETECT_ACTIONS)[number];

/** One action at every boundary, or an action for the boundaries it names; the rest keep their default. */
type DetectorRule = DetectAction | Partial<Record<Boundary, DetectAction>>;

/** One action for every detector at every boundary, or a rule for the detectors it names. */
type DetectSpec = DetectAction | Partial<Record<Detector, DetectorRule>>;

/** Every detector's action at every boundary, defaults applied. */
type ResolvedDetect = Readonly<Record<Detector, Readonly<Record<Boundary, DetectAction>>>>;

/** How a detector or an action is named and described to a builder. */
interface DetectMeta {
  label: string;
  doc: string;
}

/** The label of every detector, and what it finds. */
const DETECTOR_META: Readonly<Record<Detector, DetectMeta>> = {
  ids: { label: 'IDs', doc: 'US SSN, ITIN and EIN numbers.' },
  financial: { label: 'Financial', doc: 'IBANs and card numbers.' },
  network: { label: 'Network', doc: 'IPv4 and IPv6 addresses.' },
  credentials: {
    label: 'Credentials',
    doc: 'API keys and tokens in the formats gitleaks knows (AWS, Google, OpenAI, Anthropic, GitHub, Slack and Stripe among them), key and password assignments, OpenRouter keys, bearer tokens and PEM private keys.',
  },
  injection: {
    label: 'Injection',
    doc: 'Prompt-injection phrasing, as written or disguised.',
  },
};

/** The label of every action, and what it does. */
const DETECT_ACTION_META: Readonly<Record<DetectAction, DetectMeta>> = {
  ignore: { label: 'Ignore', doc: 'The text is not read.' },
  flag: {
    label: 'Flag',
    doc: 'The match is reported in the trace. The text crosses unchanged.',
  },
  redact: {
    label: 'Redact',
    doc: 'The match is replaced with a placeholder. The rest crosses.',
  },
  block: { label: 'Block', doc: 'The thing crossing does not cross.' },
};

const TOOL_ARGUMENT_BOUNDARIES = TOOL_KINDS.map((kind) => toolBoundary('tool_arguments', kind));

/** The default action at each boundary: text on its way to the model is redacted, a tool call is reported, and what the model writes is not read. */
function defaultsFor(toTool: DetectAction): Readonly<Record<Boundary, DetectAction>> {
  return {
    ...recordOf(INBOUND_BOUNDARIES, () => 'redact' as const),
    ...recordOf(TOOL_BOUNDARIES, () => 'redact' as const),
    ...recordOf(TOOL_ARGUMENT_BOUNDARIES, () => toTool),
    ...recordOf(OUTBOUND_BOUNDARIES, () => 'ignore' as const),
  };
}

/** What a profile that sets no `guardrails.detect` gets. No default is `block`. */
const DETECT_DEFAULTS: ResolvedDetect = {
  ...recordOf(SENSITIVE_GROUPS, () => defaultsFor('flag')),
  injection: defaultsFor('ignore'),
};

function isAction(value: unknown): value is DetectAction {
  return (DETECT_ACTIONS as readonly unknown[]).includes(value);
}

function resolveRule(
  rule: DetectorRule | undefined,
  base: Readonly<Record<Boundary, DetectAction>>,
): Readonly<Record<Boundary, DetectAction>> {
  if (rule === undefined) return base;
  if (isAction(rule)) return recordOf(BOUNDARIES, () => rule);
  return { ...base, ...rule };
}

/** `spec` with everything it leaves out taken from `base`. */
function resolveDetect(
  spec: DetectSpec | undefined,
  base: ResolvedDetect = DETECT_DEFAULTS,
): ResolvedDetect {
  if (spec === undefined) return base;
  if (isAction(spec)) return recordOf(DETECTORS, () => recordOf(BOUNDARIES, () => spec));
  return recordOf(DETECTORS, (detector) => resolveRule(spec[detector], base[detector]));
}

const ACTION_LIST = DETECT_ACTIONS.join(', ');

function ruleProblem(
  path: string,
  rule: unknown,
  boundaries: readonly Boundary[],
): string | undefined {
  if (isAction(rule)) return undefined;
  if (typeof rule !== 'object' || rule === null) {
    return `${path} must be one of ${ACTION_LIST}, or an object of boundaries`;
  }
  const known = new Set<string>(boundaries);
  for (const [boundary, action] of Object.entries(rule)) {
    if (!known.has(boundary)) {
      return `${path}.${boundary} is not a boundary this profile has (${boundaries.join(', ')})`;
    }
    if (!isAction(action)) return `${path}.${boundary} must be one of ${ACTION_LIST}`;
  }
  return undefined;
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
  if (typeof spec !== 'object' || spec === null) {
    return `${path} must be one of ${ACTION_LIST}, or an object of detectors`;
  }
  const known = new Set<string>(DETECTORS);
  for (const [detector, rule] of Object.entries(spec)) {
    if (!known.has(detector)) {
      return `${path}.${detector} is not a detector (${DETECTORS.join(', ')})`;
    }
    const problem = ruleProblem(`${path}.${detector}`, rule, boundaries);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

export type { DetectAction, DetectMeta, Detector, DetectorRule, DetectSpec, ResolvedDetect };
export {
  DETECT_ACTION_META,
  DETECT_ACTIONS,
  DETECT_DEFAULTS,
  DETECTOR_META,
  DETECTORS,
  detectProblem,
  resolveDetect,
};
