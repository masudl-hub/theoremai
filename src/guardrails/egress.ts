import type { ProviderEvent, ProviderEvidence } from '../kernel/types.ts';
import { isRecord } from '../kernel/util/record.ts';
import { guardedEventTexts, scanTextForCanaryLeak } from './canary.ts';
import { SYSTEM_BOUNDARY } from './egress-patterns.ts';
import { type GivenUrls, imageLeakSpans, linkLeakSpans, type UrlScope } from './egress-urls.ts';
import { describeError } from './error.ts';
import { hitFromSpan } from './hits.ts';
import { injectionSpans } from './injection.ts';
import { lexiconText } from './lexicon.ts';
import { scanTextForPromptEcho } from './prompt-echo.ts';
import { EGRESS_RULES } from './rules.ts';
import {
  anySensitive,
  resolveSensitive,
  SENSITIVE_GROUPS,
  type SensitiveGroups,
  type SensitiveSelection,
  sensitiveSpans,
} from './sensitive.ts';
import { textForScan } from './serialize.ts';
import type {
  EgressEnforcer,
  GuardrailContext,
  GuardrailHit,
  OutboundPayload,
  Severity,
  Verdict,
} from './types.ts';
import { SEVERITIES } from './types.ts';

function hitsFromSpans(
  text: string,
  spans: readonly { start: number; end: number }[],
  rule: string,
  severity: Severity,
): GuardrailHit[] {
  return spans.map((span) => hitFromSpan(text, span, rule, severity));
}

/** Why a reply was withheld, for the builder (`errorInternal`); the user reads `error.safety`. */
const WITHHELD_REASON = {
  canary: 'canary leaked',
  promptEcho: 'system prompt echoed', // lexicon-exempt: internal diagnostic — the user reads error.safety
  providerToolLeak: 'a provider-side tool already sent the canary or system prompt', // lexicon-exempt: internal diagnostic — the user reads error.safety
  egress: 'Turn withheld: egress disclosure violation', // lexicon-exempt: internal diagnostic — the user reads error.safety
} as const;

/** Never carries the live token, only a placeholder. */
const CANARY_HIT: GuardrailHit = { rule: EGRESS_RULES.canary, severity: 'high', match: '[canary]' };

const PROMPT_ECHO_HIT: GuardrailHit = { rule: EGRESS_RULES.promptEcho, severity: 'high' };
function canaryHits(text: string, canary?: string): GuardrailHit[] {
  return canary && scanTextForCanaryLeak(text, canary) ? [CANARY_HIT] : [];
}

/** The prompt-echo hit, when `text` repeats the guarded system prompt's own words. */
function promptEchoHits(text: string, system?: string): GuardrailHit[] {
  return system && scanTextForPromptEcho(text, system) ? [PROMPT_ECHO_HIT] : [];
}

/** The system-prompt leak hits: the canary, and the prompt's own words when guarded. */
function promptLeakHits(text: string, canary?: string, system?: string): GuardrailHit[] {
  return [...canaryHits(text, canary), ...promptEchoHits(text, system)];
}

const PROVIDER_TOOL_LEAK_HIT: GuardrailHit = {
  rule: EGRESS_RULES.providerToolLeak,
  severity: 'high',
};

/**
 * Evidence kinds that report a step the provider ran itself: its built-in
 * tools, and any step an adapter does not map (`provider_step`).
 */
const PROVIDER_TOOL_EVIDENCE: ReadonlySet<ProviderEvidence['kind']> = new Set([
  'code_execution_call',
  'code_execution_result',
  'url_context',
  'provider_step',
]);

/** The provider's report of a built-in tool it already ran. What it carries has left. */
function isProviderToolReport(event: ProviderEvent): boolean {
  return (
    event.type === 'grounding' ||
    (event.type === 'evidence' && PROVIDER_TOOL_EVIDENCE.has(event.evidence.kind))
  );
}

/**
 * The system-prompt leak hits in any content-bearing field of an event
 * (`guardedEventTexts`). In the report of a provider-side tool they are one
 * `egress.provider-tool-leak`: the call already ran.
 */
function eventPromptLeakHits(
  event: ProviderEvent,
  canary?: string,
  system?: string,
): GuardrailHit[] {
  const hits = guardedEventTexts(event).flatMap((text) => promptLeakHits(text, canary, system));
  if (hits.length > 0 && isProviderToolReport(event)) {
    return [PROVIDER_TOOL_LEAK_HIT];
  }
  return [...new Map(hits.map((hit) => [hit.rule, hit])).values()];
}

const PROMPT_LEAK_RULES = new Set<string>([
  EGRESS_RULES.canary,
  EGRESS_RULES.promptEcho,
  EGRESS_RULES.providerToolLeak,
]);

/** Whether a hit is a system-prompt leak: a hard stop under any host policy. */
function isPromptLeakHit(hit: GuardrailHit): boolean {
  return PROMPT_LEAK_RULES.has(hit.rule);
}

/** Why a system-prompt leak withheld the reply, for the builder. */
function promptLeakReason(hits: GuardrailHit[]): string {
  if (hits.some((hit) => hit.rule === EGRESS_RULES.providerToolLeak)) {
    return WITHHELD_REASON.providerToolLeak;
  }
  return hits.some((hit) => hit.rule === EGRESS_RULES.canary)
    ? WITHHELD_REASON.canary
    : WITHHELD_REASON.promptEcho;
}

/** Where a URL check lets a URL through beyond the ones the model was given. */
interface UrlCheck {
  /** Hostnames the check lets through whatever their URL, such as the host's own CDN. */
  hosts?: readonly string[];
  /**
   * Whether a URL a tool returned counts as given. Default true. A tool result
   * can offer the model URLs to pick from, and the pick tells their server
   * something; false closes that channel, and keeps only what the system
   * prompt, the user and host history gave.
   */
  fromTools?: boolean;
}

/**
 * Which bundled egress checks run; a check left out keeps its default. The
 * system-prompt leak checks are not among them: `guardrails.canary` and
 * `guardrails.promptEcho` switch those, and they run under any policy.
 */
interface EgressChecks {
  /**
   * Sensitive data in the reply, by group. Default every group but `network`:
   * an address in a reply is not a secret, and replies explaining networks
   * cite them.
   */
  sensitive?: SensitiveSelection;
  /** The fence the kernel puts around user data, and the canary's note. Default on. */
  boundary?: boolean;
  /** Injection phrasing in the reply, as written or disguised. Default on. */
  injection?: boolean;
  /** Images that load a URL the model was not given. Default on. */
  images?: boolean | UrlCheck;
  /**
   * Links to a URL the model was not given. Default off: a link loads on a
   * click, or where the host unfurls links into previews, and replies cite
   * pages from what the model knows. A host that unfurls turns it on.
   */
  links?: boolean | UrlCheck;
}

/** `EgressChecks` with defaults applied; a URL check is undefined when off. */
interface ResolvedEgressChecks {
  sensitive: SensitiveGroups;
  boundary: boolean;
  injection: boolean;
  images?: UrlCheck;
  links?: UrlCheck;
}

const EGRESS_SENSITIVE_DEFAULT: SensitiveGroups = {
  ids: true,
  financial: true,
  network: false,
  credentials: true,
};

function resolveUrlCheck(check: boolean | UrlCheck | undefined, byDefault: boolean) {
  if (check === undefined) return byDefault ? {} : undefined;
  if (typeof check === 'boolean') return check ? {} : undefined;
  return check;
}

function resolveEgressChecks(checks: EgressChecks = {}): ResolvedEgressChecks {
  const images = resolveUrlCheck(checks.images, true);
  const resolved = resolveUrlCheck(checks.links, false);
  // A host images load from already takes data with no click, so a link there opens nothing new.
  const links =
    resolved && images?.hosts
      ? { ...resolved, hosts: [...new Set([...(resolved.hosts ?? []), ...images.hosts])] }
      : resolved;
  return {
    sensitive: resolveSensitive(checks.sensitive, EGRESS_SENSITIVE_DEFAULT),
    boundary: checks.boundary ?? true,
    injection: checks.injection ?? true,
    ...(images ? { images } : {}),
    ...(links ? { links } : {}),
  };
}

/** Every check off: the system-prompt leak checks alone. */
const NO_CHECKS: ResolvedEgressChecks = resolveEgressChecks({
  sensitive: false,
  boundary: false,
  injection: false,
  images: false,
});

const DEFAULT_CHECKS: ResolvedEgressChecks = resolveEgressChecks();

/** What the bundled policy reads besides the reply. */
interface EgressScope {
  canary?: string;
  system?: string;
  /** The URLs the model was given this turn. */
  given?: GivenUrls;
}

function urlScope(check: UrlCheck, given: GivenUrls | undefined): UrlScope {
  return { ...check, ...(given ? { given } : {}) };
}

/** The bundled policy's hits in `text`, from the checks `checks` runs. */
function collectEgressHits(
  text: string,
  scope: EgressScope = {},
  checks: ResolvedEgressChecks = DEFAULT_CHECKS,
): GuardrailHit[] {
  const hits = promptLeakHits(text, scope.canary, scope.system);
  if (anySensitive(checks.sensitive)) {
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    hits.push(
      ...hitsFromSpans(
        text,
        sensitiveSpans(text, checks.sensitive),
        EGRESS_RULES.sensitive,
        'high',
      ),
    );
  }
  const boundary = checks.boundary ? SYSTEM_BOUNDARY.exec(text) : null;
  if (boundary && boundary.index !== undefined) {
    hits.push(
      hitFromSpan(
        text,
        { start: boundary.index, end: boundary.index + boundary[0].length },
        EGRESS_RULES.boundary,
        'medium',
      ),
    );
  }
  if (checks.injection) {
    hits.push(...hitsFromSpans(text, injectionSpans(text), EGRESS_RULES.injection, 'medium')); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  if (checks.images) {
    const spans = imageLeakSpans(text, urlScope(checks.images, scope.given));
    hits.push(...hitsFromSpans(text, spans, EGRESS_RULES.image, 'high'));
  }
  if (checks.links) {
    const spans = linkLeakSpans(text, urlScope(checks.links, scope.given), Boolean(checks.images));
    hits.push(...hitsFromSpans(text, spans, EGRESS_RULES.link, 'high'));
  }
  return hits;
}

function hitRules(hits: GuardrailHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.rule))];
}

function isGuardrailHit(value: unknown): value is GuardrailHit {
  if (
    !isRecord(value) ||
    typeof value.rule !== 'string' ||
    !value.rule.trim() ||
    !SEVERITIES.includes(value.severity as Severity)
  ) {
    return false;
  }
  for (const key of ['match', 'label', 'doc'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.span !== undefined) {
    if (
      !isRecord(value.span) ||
      typeof value.span.start !== 'number' ||
      !Number.isFinite(value.span.start) ||
      typeof value.span.end !== 'number' ||
      !Number.isFinite(value.span.end)
    ) {
      return false;
    }
  }
  return true;
}

function isGuardrailHits(value: unknown): value is GuardrailHit[] {
  return Array.isArray(value) && value.every(isGuardrailHit);
}

function isVerdict(value: unknown): value is Verdict {
  if (!isRecord(value)) return false;
  switch (value.action) {
    case 'allow':
      return true;
    case 'redact':
      return typeof value.text === 'string' && isGuardrailHits(value.hits);
    case 'flag':
      return isGuardrailHits(value.hits);
    case 'block':
      return (
        isGuardrailHits(value.hits) &&
        typeof value.rejection === 'string' &&
        (value.errorInternal === undefined || typeof value.errorInternal === 'string')
      );
    default:
      return false;
  }
}

function legacyHits(value: unknown): GuardrailHit[] {
  if (!Array.isArray(value)) {
    return [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }];
  }
  const hits = value
    .map((hit): GuardrailHit | undefined => {
      if (typeof hit === 'string' && hit.trim()) {
        return { rule: hit, severity: 'high' };
      }
      if (isRecord(hit) && typeof hit.rule === 'string' && hit.rule.trim()) {
        const severity = SEVERITIES.includes(hit.severity as Severity)
          ? (hit.severity as Severity)
          : 'high';
        return {
          rule: hit.rule,
          severity,
          ...(typeof hit.label === 'string' ? { label: hit.label } : {}),
          ...(typeof hit.doc === 'string' ? { doc: hit.doc } : {}),
        };
      }
      return undefined;
    })
    .filter((hit): hit is GuardrailHit => Boolean(hit));
  return hits.length ? hits : [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }];
}

function normalizeVerdict(value: unknown, context: GuardrailContext): Verdict {
  if (isVerdict(value)) {
    return value;
  }
  if (isRecord(value) && typeof value.blocked === 'boolean') {
    if (!value.blocked) {
      return { action: 'allow' };
    }
    const hits = legacyHits(value.hits);
    const rejection =
      typeof value.rejectionMessage === 'string' && value.rejectionMessage.trim()
        ? value.rejectionMessage
        : lexiconText('egress.rejection', { rules: hitRules(hits).join(', ') }, context.lexicon);
    return { action: 'block', hits, rejection };
  }
  return {
    action: 'block',
    hits: [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }],
    rejection: lexiconText('egress.invalid_verdict', {}, context.lexicon),
  };
}

/** An enforce that blocks on `collect`'s hits in the reply and in any structured output. */
function hitsEnforcer(
  collect: (text: string, context: GuardrailContext) => GuardrailHit[],
): (payload: OutboundPayload, context: GuardrailContext) => Verdict {
  return (payload, context) => {
    const hits = collect(payload.text, context);
    if (payload.structured !== undefined) {
      const structured = textForScan(payload.structured);
      if (structured.unscannable) {
        // Cannot inspect it, so cannot vouch for it. Fail closed.
        hits.push({ rule: EGRESS_RULES.unscannable, severity: 'high' }); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      } else {
        hits.push(...collect(structured.text, context));
      }
    }
    if (hits.length === 0) {
      return { action: 'allow' };
    }
    return {
      action: 'block',
      hits,
      rejection: lexiconText(
        'egress.rejection',
        { rules: hitRules(hits).join(', ') },
        context.lexicon,
      ),
    };
  };
}

/** What the bundled policy reads from a gate's context. */
function egressScope(context: GuardrailContext): EgressScope {
  return {
    ...(context.canary ? { canary: context.canary } : {}),
    ...(context.system ? { system: context.system } : {}),
    ...(context.givenUrls ? { given: context.givenUrls } : {}),
  };
}

/** Default egress enforce: every bundled check at its default (`EgressChecks`). */
const standardEgressEnforce: (payload: OutboundPayload, context: GuardrailContext) => Verdict =
  hitsEnforcer((text, context) => collectEgressHits(text, egressScope(context)));

/** The bundled checks each enforce runs, for the enforces built from them. */
const KNOWN_CHECKS = new WeakMap<EgressEnforcer, ResolvedEgressChecks>([
  [standardEgressEnforce, DEFAULT_CHECKS],
]);

function registerEgressChecks(enforce: EgressEnforcer, checks: ResolvedEgressChecks): void {
  KNOWN_CHECKS.set(enforce, checks);
}

/** The bundled checks `enforce` runs; undefined for a host enforce, whose checks are its own. */
function egressChecksOf(enforce: EgressEnforcer | undefined): ResolvedEgressChecks | undefined {
  return enforce && KNOWN_CHECKS.get(enforce);
}

const CHECK_NAMES = new Set(['sensitive', 'boundary', 'injection', 'images', 'links']);
const URL_CHECK_NAMES = new Set(['hosts', 'fromTools']);
const GROUP_NAMES = new Set<string>(SENSITIVE_GROUPS);

/** A hostname is all a URL check's host is: a scheme, port or path would never match one. */
function urlCheckProblem(path: string, check: unknown): string | undefined {
  if (check === undefined || typeof check === 'boolean') return undefined;
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (typeof check !== 'object' || check === null) return `${path} must be a boolean or an object`;
  const unknown = Object.keys(check).find((key) => !URL_CHECK_NAMES.has(key));
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (unknown !== undefined) return `${path} has no option ${JSON.stringify(unknown)}`;
  const { hosts, fromTools } = check as UrlCheck;
  if (fromTools !== undefined && typeof fromTools !== 'boolean') {
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return `${path}.fromTools must be a boolean`;
  }
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (hosts !== undefined && !Array.isArray(hosts)) return `${path}.hosts must be a list`;
  const bad = (hosts ?? []).find(
    (host) => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.'),
  );
  return bad === undefined
    ? undefined
    : // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      `${path}.hosts lists ${JSON.stringify(bad)}, which is not a hostname`;
}

/** A misspelt check or group would leave the check it meant at its default, silently. */
function egressChecksProblem(path: string, checks: unknown): string | undefined {
  if (typeof checks === 'boolean') return undefined;
  if (typeof checks !== 'object' || checks === null)
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    return `${path} must be a boolean or an object`;
  const unknown = Object.keys(checks).find((key) => !CHECK_NAMES.has(key));
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  if (unknown !== undefined) return `${path} has no check ${JSON.stringify(unknown)}`;
  const { sensitive, boundary, injection, images, links } = checks as EgressChecks;
  for (const [name, value] of [
    ['boundary', boundary],
    ['injection', injection],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean')
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return `${path}.${name} must be a boolean`;
  }
  if (sensitive !== undefined && typeof sensitive !== 'boolean') {
    if (typeof sensitive !== 'object' || sensitive === null) {
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return `${path}.sensitive must be a boolean or an object`;
    }
    const unknownGroup = Object.keys(sensitive).find((group) => !GROUP_NAMES.has(group));
    if (unknownGroup !== undefined) {
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      return `${path}.sensitive has no group ${JSON.stringify(unknownGroup)} (${SENSITIVE_GROUPS.join(', ')})`;
    }
    const bad = Object.entries(sensitive).find(([, on]) => typeof on !== 'boolean');
    // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    if (bad !== undefined) return `${path}.sensitive.${bad[0]} must be a boolean`;
  }
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return urlCheckProblem(`${path}.images`, images) ?? urlCheckProblem(`${path}.links`, links);
}

/**
 * A policy that throws has reached no decision, so it cannot vouch for the output:
 * the failure becomes a `block`, not a pass. The turn then follows the profile's
 * ordinary `onBlock` handling instead of surfacing a raw host stack trace. The
 * thrown message may carry host internals, so it goes to the builder only
 * (`errorInternal`); the model reads the lexicon's `egress.policy_failed`.
 */
async function runEnforcer(
  enforce: EgressEnforcer,
  payload: OutboundPayload,
  context: GuardrailContext,
): Promise<Verdict> {
  try {
    return normalizeVerdict(await enforce(payload, context), context);
  } catch (err) {
    return {
      action: 'block',
      hits: [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }],
      rejection: lexiconText('egress.policy_failed', {}, context.lexicon),
      errorInternal: describeError(err),
    };
  }
}

export type { EgressChecks, EgressScope, ResolvedEgressChecks, UrlCheck };
export {
  CANARY_HIT,
  collectEgressHits,
  DEFAULT_CHECKS,
  egressChecksOf,
  egressChecksProblem,
  egressScope,
  eventPromptLeakHits,
  hitRules,
  hitsEnforcer,
  isPromptLeakHit,
  NO_CHECKS,
  PROMPT_ECHO_HIT,
  promptEchoHits,
  promptLeakReason,
  registerEgressChecks,
  resolveEgressChecks,
  runEnforcer,
  standardEgressEnforce,
  WITHHELD_REASON,
};
