import type { ProviderEvent, ProviderEvidence } from '../kernel/types.ts';
import { canaryNoteMarker, guardedEventTexts, scanTextForCanaryLeak } from './canary.ts';
import type { DetectAction, ResolvedDetect } from './detectors.ts';
import { SYSTEM_BOUNDARY } from './egress-patterns.ts';
import { CANARY_HIT, PROMPT_ECHO_HIT } from './hits.ts';
import { scanTextForPromptEcho } from './prompt-echo.ts';
import { DETECT_RULES, EGRESS_RULES } from './rules.ts';
import type { GuardrailContext, GuardrailHit } from './types.ts';

/** Why a reply was withheld, for the builder (`errorInternal`); the user reads `error.safety`. */
const WITHHELD_REASON = {
  canary: 'canary leaked',
  promptEcho: 'system prompt echoed', // lexicon-exempt: internal diagnostic — the user reads error.safety
  providerToolLeak: 'a provider-side tool already sent the canary or system prompt', // lexicon-exempt: internal diagnostic — the user reads error.safety
  egress: 'Turn withheld: egress disclosure violation', // lexicon-exempt: internal diagnostic — the user reads error.safety
} as const;

function canaryHits(text: string, canary?: string): GuardrailHit[] {
  return canary && scanTextForCanaryLeak(text, canary) ? [CANARY_HIT] : [];
}

/** The prompt-echo hit, when `text` repeats the guarded system prompt's own words. */
function promptEchoHits(
  text: string,
  privateSystem?: readonly string[],
  canary?: string,
): GuardrailHit[] {
  return privateSystem && scanTextForPromptEcho(text, privateSystem, canary)
    ? [PROMPT_ECHO_HIT]
    : [];
}

/** What a prompt-leak check reads of the turn. */
type LeakScope = Pick<GuardrailContext, 'canary' | 'canaryGiven' | 'privateSystem'>;

/** The system-prompt leak hits: the canary unless it was given, and the prompt's own words when guarded. */
function promptLeakHits(text: string, scope: LeakScope): GuardrailHit[] {
  const { canary, canaryGiven, privateSystem } = scope;
  return [
    ...canaryHits(text, canaryGiven ? undefined : canary),
    ...promptEchoHits(text, privateSystem, canary),
  ];
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
function eventPromptLeakHits(event: ProviderEvent, scope: LeakScope): GuardrailHit[] {
  const hits = guardedEventTexts(event).flatMap((text) => promptLeakHits(text, scope));
  if (hits.length > 0 && isProviderToolReport(event)) {
    return [PROVIDER_TOOL_LEAK_HIT];
  }
  return [...new Map(hits.map((hit) => [hit.rule, hit])).values()];
}

/** A leak of ours in an event that is not the reply's text: its hits, and whether it stops the turn. */
interface EventLeak {
  stop: boolean;
  hits: GuardrailHit[];
}

/**
 * What the detectors of what is ours find in an event's host content
 * (`guardedEventTexts`) under their actions at `boundary`, as the event goes
 * to the host with the reply. `flag` reports it; `redact` and `block` stop the
 * turn, as an event has no text to replace. The report of a provider-side tool
 * is read whatever the actions are and always stops: the call already ran.
 */
function eventLeak(
  event: ProviderEvent,
  scope: LeakScope,
  detect: ResolvedDetect,
  boundary: 'reply' | 'live_reply',
): EventLeak | undefined {
  if (isProviderToolReport(event)) {
    const hits = eventPromptLeakHits(event, scope);
    return hits.length > 0 ? { stop: true, hits } : undefined;
  }
  const texts = guardedEventTexts(event);
  const found: [DetectAction, GuardrailHit][] = [];
  const canary = scope.canaryGiven ? undefined : scope.canary;
  const canaryAction = detect.canary_leak[boundary];
  if (canaryAction !== 'ignore' && texts.some((text) => canaryHits(text, canary).length > 0)) {
    found.push([canaryAction, CANARY_HIT]);
  }
  const promptAction = detect.prompt_leak[boundary];
  if (
    promptAction !== 'ignore' &&
    texts.some((text) => promptEchoHits(text, scope.privateSystem, scope.canary).length > 0)
  ) {
    found.push([promptAction, PROMPT_ECHO_HIT]);
  }
  if (found.length === 0) return undefined;
  return {
    stop: found.some(([action]) => action !== 'flag'),
    hits: found.map(([, hit]) => hit),
  };
}

const PROMPT_LEAK_RULES = new Set<string>([
  DETECT_RULES.canary_leak,
  DETECT_RULES.prompt_leak,
  EGRESS_RULES.providerToolLeak,
]);

/** Whether a hit is a system-prompt leak. */
function isPromptLeakHit(hit: GuardrailHit): boolean {
  return PROMPT_LEAK_RULES.has(hit.rule);
}

/** Why a system-prompt leak withheld the reply, for the builder. */
function promptLeakReason(hits: GuardrailHit[]): string {
  if (hits.some((hit) => hit.rule === EGRESS_RULES.providerToolLeak)) {
    return WITHHELD_REASON.providerToolLeak;
  }
  return hits.some((hit) => hit.rule === DETECT_RULES.canary_leak)
    ? WITHHELD_REASON.canary
    : WITHHELD_REASON.promptEcho;
}

/** The distinct rule names among the hits. */
function hitRules(hits: GuardrailHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.rule))];
}

/**
 * The words of the canary note a turn binds, when the profile's lexicon
 * rewords it so that `SYSTEM_BOUNDARY` no longer reads them.
 */
function boundaryNote({
  canary,
  lexicon,
}: Pick<GuardrailContext, 'canary' | 'lexicon'>): string | undefined {
  if (!canary) return undefined;
  const marker = canaryNoteMarker(lexicon);
  return marker && !SYSTEM_BOUNDARY.test(marker) ? marker : undefined;
}

export type { EventLeak, LeakScope };
export {
  boundaryNote,
  eventLeak,
  eventPromptLeakHits,
  hitRules,
  isPromptLeakHit,
  promptEchoHits,
  promptLeakReason,
  WITHHELD_REASON,
};
