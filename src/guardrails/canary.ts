import { mapStrings } from '../kernel/engine/tree.ts';
import type { TurnEvent } from '../kernel/types.ts';
import { TheoremError } from './error.ts';
import { lexiconText } from './lexicon.ts';
import { scanTextOf } from './serialize.ts';

const USER_OPEN = '<user_data>';
const USER_CLOSE = '</user_data>';
const CANARY_PREFIX = 'theo-';
const CANARY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;
/** Literal placeholder substituted for a canary when an event is redacted. */
const OMIT_CANARY = '[omitted - canary]';
const FENCE = /<\/?user_data>/gi;
/** Base64 prefix hint for the literal string "theo". */
const B64_THEO_HINT = 'dGhlbw';

/** Creates a 128-bit, cryptographically random token for one turn's canary binding. */
function mintCanary(): string {
  const bytes = new Uint8Array(CANARY_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(HEX_RADIX).padStart(HEX_PAD, '0');
  }
  return `${CANARY_PREFIX}${hex}`;
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
 * Returns whether text contains a canary literally, as its base64 encoding, or
 * as spaced hexadecimal characters. This is leak detection, not general-purpose
 * encoded-data detection.
 */
function scanTextForCanaryLeak(text: string, canary: string): boolean {
  if (!text || !canary) {
    return false;
  }
  if (text.includes(canary)) {
    return true;
  }
  try {
    const encoded = btoa(canary);
    if (text.includes(encoded)) {
      return true;
    }
  } catch {
    /* ignore invalid btoa input */
  }
  if (!text.includes('theo') && !text.includes(B64_THEO_HINT)) {
    return false;
  }
  const hex = canary.startsWith(CANARY_PREFIX) ? canary.slice(CANARY_PREFIX.length) : '';
  if (hex.length > 0) {
    const spaced = hex.split('').join(' ');
    if (text.includes(spaced)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks the content-bearing fields currently emitted by a turn event, including
 * text, errors, structured payloads, tool data, evidence, and session metadata.
 */
function eventHasCanary(event: TurnEvent, canary: string): boolean {
  if (!canary) {
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
 * Incremental canary scanner that retains `canary.length - 1` trailing characters
 * so a token split across adjacent stream chunks is not released prematurely.
 */
interface CanaryStreamGate {
  process: (fragment: string) => CanaryGateResult;
  flush: () => CanaryGateResult;
}

/** Creates an incremental scanner for one canary token; call `flush` at stream end. */
function createCanaryStreamGate(canary: string): CanaryStreamGate {
  const overlap = Math.max(0, canary.length - 1);
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

function isStreamedCanaryEvent(
  event: TurnEvent,
): event is TurnEvent & { type: 'text' | 'thought' } {
  return event.type === 'text' || event.type === 'thought';
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
