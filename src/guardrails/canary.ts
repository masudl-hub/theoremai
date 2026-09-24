import { mapStrings } from '../kernel/engine/tree.ts';
import type { TurnEvent } from '../kernel/types.ts';
import { TheoremError } from './error.ts';
import { lexiconText } from './lexicon.ts';
import { scanTextOf } from './serialize.ts';

const USER_OPEN = '<user_data>';
const USER_CLOSE = '</user_data>';
const CANARY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;
/** Literal placeholder substituted for a canary when an event is redacted. */
const OMIT_CANARY = '[omitted - canary]';
const FENCE = /<\/?user_data>/gi;

/** Creates a 128-bit, cryptographically random token for one turn's canary binding. */
function mintCanary(): string {
  const bytes = new Uint8Array(CANARY_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(HEX_RADIX).padStart(HEX_PAD, '0');
  }
  return hex;
}

function stripUserFences(text: string): string {
  return text.replaceAll(FENCE, '').trim();
}

/**
 * Removes pre-existing user-data fences, trims the input, and encloses the result
 * in the canonical user-data fence used by the guardrail prompt contract.
 */
function wrapUserData(text: string): string {
  return `${USER_OPEN}\n${stripUserFences(text)}\n${USER_CLOSE}`;
}

/**
 * Append the canary bind note to the host's system prompt.
 *
 * The note is mechanism text with an overridable registered default
 * (`canary.bind_note` in the lexicon) or a per-profile template
 * (`guardrails.canary.bindNote`). Either way the template must contain the
 * `{canary}` placeholder — a note without the token binds nothing.
 */
function bindCanary(system: string, canary: string, bindNote?: string): string {
  if (!canary) {
    return system;
  }
  if (bindNote !== undefined && !bindNote.includes('{canary}')) {
    throw new TheoremError(
      'guardrails.canary.bindNote must contain the {canary} placeholder', // lexicon-exempt: developer contract error
    );
  }
  const note = lexiconText('canary.bind_note', { canary }, bindNote);
  if (!system) {
    return note;
  }
  return `${system}\n\n${note}`;
}

/**
 * Every form a leaked canary is detected in: literal, spaced out character by
 * character, and base64. The token carries no fixed prefix, so no form depends
 * on a marker the model could drop or split off.
 */
function canaryLeakForms(canary: string): string[] {
  const forms = [canary, [...canary].join(' ')];
  try {
    forms.push(btoa(canary));
  } catch {
    /* a host canary outside Latin-1 has no base64 form */
  }
  return forms;
}

/** Longest detected leak form: the lookback a split leak needs to stay catchable. */
function canaryLeakSpan(canary: string): number {
  return Math.max(...canaryLeakForms(canary).map((form) => form.length));
}

/**
 * Returns whether text contains a canary in any detected leak form
 * (`canaryLeakForms`). This is leak detection, not general-purpose
 * encoded-data detection.
 */
function scanTextForCanaryLeak(text: string, canary: string): boolean {
  if (!text || !canary) {
    return false;
  }
  return canaryLeakForms(canary).some((form) => text.includes(form));
}

/**
 * Thinking is not guarded output: a host that shows `thought` events accepts
 * what they contain, and a thinking model restates its system prompt as it
 * reasons. Every outbound gate reads this before scanning.
 */
function isGuardedOutput(event: TurnEvent): boolean {
  return event.type !== 'thought';
}

/**
 * Checks the content-bearing fields currently emitted by a turn event, including
 * text, errors, structured payloads, tool data, evidence, and session metadata.
 * Unguarded output (`isGuardedOutput`) never carries a leak.
 */
function eventHasCanary(event: TurnEvent, canary: string): boolean {
  if (!canary || !isGuardedOutput(event)) {
    return false;
  }
  if (event.text && scanTextForCanaryLeak(event.text, canary)) {
    return true;
  }
  if (event.error && scanTextForCanaryLeak(event.error, canary)) {
    return true;
  }
  if (
    event.structured !== undefined &&
    scanTextForCanaryLeak(scanTextOf(event.structured), canary)
  ) {
    return true;
  }
  if (event.tool !== undefined && scanTextForCanaryLeak(scanTextOf(event.tool), canary)) {
    return true;
  }
  if (event.grounding !== undefined && scanTextForCanaryLeak(scanTextOf(event.grounding), canary)) {
    return true;
  }
  if (event.evidence !== undefined && scanTextForCanaryLeak(scanTextOf(event.evidence), canary)) {
    return true;
  }
  if (event.session !== undefined && scanTextForCanaryLeak(scanTextOf(event.session), canary)) {
    return true;
  }
  if (
    event.sessionResumptionHandle &&
    scanTextForCanaryLeak(event.sessionResumptionHandle, canary)
  ) {
    return true;
  }
  return false;
}

/** Result of scanning one streamed window: either a leak or the prefix safe to emit. */
type CanaryGateResult = { leak: true } | { leak: false; emit: string };

/**
 * Incremental canary scanner that retains one character less than the longest
 * leak form (`canaryLeakSpan`), so a leak split across adjacent stream chunks
 * is not released prematurely.
 */
interface CanaryStreamGate {
  process: (fragment: string) => CanaryGateResult;
  flush: () => CanaryGateResult;
}

/** Creates an incremental scanner for one canary token; call `flush` at stream end. */
function createCanaryStreamGate(canary: string): CanaryStreamGate {
  const overlap = Math.max(0, canaryLeakSpan(canary) - 1);
  let pending = '';

  function step(window: string): CanaryGateResult {
    if (scanTextForCanaryLeak(window, canary)) {
      return { leak: true };
    }
    const safeEnd = Math.max(0, window.length - overlap);
    const emit = window.slice(0, safeEnd);
    pending = window.slice(safeEnd);
    return { leak: false, emit };
  }

  return {
    process(fragment: string): CanaryGateResult {
      if (!fragment) {
        return { leak: false, emit: '' };
      }
      return step(pending + fragment);
    },
    flush(): CanaryGateResult {
      if (scanTextForCanaryLeak(pending, canary)) {
        return { leak: true };
      }
      const emit = pending;
      pending = '';
      return { leak: false, emit };
    },
  };
}

/**
 * The reply as it streams: text deltas, and the transcript of spoken output
 * (Live `output_transcription` evidence). The one stream the outbound gates
 * scan progressively; everything else is scanned whole per event.
 */
function isStreamedCanaryEvent(event: TurnEvent): boolean {
  return (
    event.type === 'text' ||
    (event.type === 'evidence' && event.evidence?.kind === 'output_transcription')
  );
}

/** Replaces literal canary occurrences in every string field of an event. */
function redactCanary(event: TurnEvent, canary: string): TurnEvent {
  const next = mapStrings(event, (text) => text.replaceAll(canary, OMIT_CANARY));
  if (next && typeof next === 'object') {
    return next as TurnEvent;
  }
  return event;
}

export type { CanaryGateResult, CanaryStreamGate };
export {
  bindCanary,
  canaryLeakSpan,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
};
