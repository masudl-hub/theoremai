import { mapStrings } from '../kernel/engine/tree.ts';
import {
  type ProviderEvent,
  type TurnEvent,
  type TurnEventOf,
  turnEventSchema,
} from '../kernel/turn-events.ts';
import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { scanTextOf } from './serialize.ts';

const USER_OPEN = '<user_data>';
const USER_CLOSE = '</user_data>';
const CANARY_BYTES = 16;
const HEX_RADIX = 16;
const HEX_PAD = 2;
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
 * The note is the lexicon's `canary.bind_note`: the profile's `lexicon`, then
 * `overrideLexicon`, then the default. Every override is checked for the
 * `{canary}` placeholder when it is set — a note without the token binds nothing.
 */
function bindCanary(system: string, canary: string, lexicon?: LexiconOverrides): string {
  if (!canary) {
    return system;
  }
  const note = lexiconText('canary.bind_note', { canary }, lexicon);
  if (!system) {
    return note;
  }
  return `${system}\n\n${note}`;
}

/** Appends the lexicon's `user_data.note`, which tells the model what `wrapUserData`'s tags mean. */
function bindUserDataNote(system: string, lexicon?: LexiconOverrides): string {
  const note = lexiconText('user_data.note', {}, lexicon);
  if (!note) return system;
  return system ? `${system}\n\n${note}` : note;
}

/**
 * One shape a leaked canary is detected in. The scan reads only the characters
 * the form is written with, so whatever separates them — spaces, dashes, line
 * breaks — and, for the literal form, their case do not hide the token.
 */
interface CanaryLeakForm {
  value: string;
  keeps: (char: string) => boolean;
  foldCase: boolean;
}

const BASE64_CHAR = /^[A-Za-z0-9+/=]$/;

/**
 * Every form a leaked canary is detected in: the token itself and its base64.
 * The token carries no fixed prefix, so no form depends on a marker the model
 * could drop or split off.
 */
function canaryLeakForms(canary: string): CanaryLeakForm[] {
  const literal = canary.toLowerCase();
  const alphabet = new Set(literal.split(''));
  const forms: CanaryLeakForm[] = [
    { value: literal, keeps: (char) => alphabet.has(char.toLowerCase()), foldCase: true },
  ];
  try {
    forms.push({ value: btoa(canary), keeps: (char) => BASE64_CHAR.test(char), foldCase: false });
  } catch {
    /* a host canary outside Latin-1 has no base64 form */
  }
  return forms;
}

/** The characters of `text` a form reads, with the offset in `text` each came from. */
interface CanaryProjection {
  kept: string;
  at: number[];
}

function projectFor(text: string, form: CanaryLeakForm): CanaryProjection {
  let kept = '';
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (form.keeps(char)) {
      kept += form.foldCase ? char.toLowerCase() : char;
      at.push(index);
    }
  }
  return { kept, at };
}

/** Offsets `[start, end)` of `text` covering each leak, ordered by start. */
function canaryLeakRanges(text: string, canary: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const form of canaryLeakForms(canary)) {
    const { kept, at } = projectFor(text, form);
    const size = form.value.length;
    for (
      let found = kept.indexOf(form.value);
      found >= 0;
      found = kept.indexOf(form.value, found + size)
    ) {
      ranges.push([at[found] ?? 0, (at[found + size - 1] ?? 0) + 1]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Leak detection over `canaryLeakForms` only, not general-purpose encoded-data detection. */
function scanTextForCanaryLeak(text: string, canary: string): boolean {
  if (!text || !canary) {
    return false;
  }
  return canaryLeakForms(canary).some((form) => projectFor(text, form).kept.includes(form.value));
}

/**
 * Offset from which `text` must stay held: the earliest point where what
 * follows is the start of a leak form, and so could still grow into a leak.
 * Everything before it is safe to release whatever arrives next.
 */
function canaryHoldFrom(text: string, canary: string): number {
  let from = text.length;
  if (!canary) {
    return from;
  }
  for (const form of canaryLeakForms(canary)) {
    const { kept, at } = projectFor(text, form);
    for (let size = Math.min(kept.length, form.value.length - 1); size > 0; size--) {
      if (kept.endsWith(form.value.slice(0, size))) {
        from = Math.min(from, at[kept.length - size] ?? from);
        break;
      }
    }
  }
  return from;
}

function redactCanaryText(text: string, canary: string): string {
  if (!text || !canary) {
    return text;
  }
  let out = '';
  let from = 0;
  for (const [start, end] of canaryLeakRanges(text, canary)) {
    if (start >= from) {
      out += `${text.slice(from, start)}${OMIT_CANARY}`;
    }
    from = Math.max(from, end);
  }
  return out + text.slice(from);
}

/**
 * Thinking is not guarded output: a host that shows `thought` events accepts
 * what they contain, and a thinking model restates its system prompt as it
 * reasons. Every outbound gate reads this before scanning.
 */
function isGuardedOutput(event: ProviderEvent): boolean {
  return event.type !== 'thought';
}

/**
 * What of an event reaches the host as content: the one list every canary
 * scan reads. Builder-only fields (`errorInternal`), counts, identities, and
 * media bytes are not content.
 */
function hostContentOf(event: ProviderEvent): unknown {
  switch (event.type) {
    case 'text':
    case 'thought':
      return event.text;
    case 'structured':
      return event.structured;
    case 'grounding':
      return event.grounding;
    case 'citation':
      return event.sources;
    case 'compaction':
      return event.summary;
    case 'evidence':
      return [event.evidence, event.text, event.sessionResumptionHandle];
    case 'session':
      return event.session;
    case 'tool':
      return event.tool;
    case 'error':
      return [event.error, event.errorCopy];
    case 'media':
    case 'tokens':
    case 'guardrail':
    case 'stage':
    case 'done':
    case 'response':
      return undefined;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/**
 * Whether an event's host content (`hostContentOf`) carries a leak.
 * Unguarded output (`isGuardedOutput`) never carries one.
 */
function eventHasCanary(event: ProviderEvent, canary: string): boolean {
  if (!canary || !isGuardedOutput(event)) {
    return false;
  }
  const content = hostContentOf(event);
  return content !== undefined && scanTextForCanaryLeak(scanTextOf(content), canary);
}

type CanaryGateResult = { leak: true } | { leak: false; emit: string };

/**
 * Incremental canary scanner that retains the tail that could start a leak
 * (`canaryHoldFrom`), so a leak split across adjacent stream chunks is not
 * released prematurely.
 */
interface CanaryStreamGate {
  process: (fragment: string) => CanaryGateResult;
  flush: () => CanaryGateResult;
}

/** Call `flush` at stream end to release the held tail. */
function createCanaryStreamGate(canary: string): CanaryStreamGate {
  let pending = '';

  function step(window: string): CanaryGateResult {
    if (scanTextForCanaryLeak(window, canary)) {
      return { leak: true };
    }
    const safeEnd = canaryHoldFrom(window, canary);
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

type StreamedReplyEvent = TurnEventOf<'text' | 'evidence'>;

/**
 * The reply as it streams: text deltas, and the transcript of spoken output
 * (Live `output_transcription` evidence). The one stream the outbound gates
 * scan progressively; everything else is scanned whole per event.
 */
function isStreamedCanaryEvent(event: ProviderEvent): event is StreamedReplyEvent {
  return (
    event.type === 'text' ||
    (event.type === 'evidence' && event.evidence.kind === 'output_transcription')
  );
}

function redactCanary(event: TurnEvent, canary: string): TurnEvent {
  // Replacing strings keeps the event's shape; the parse re-types it.
  return turnEventSchema.parse(mapStrings(event, (text) => redactCanaryText(text, canary)));
}

export type { CanaryGateResult, CanaryStreamGate, StreamedReplyEvent };
export {
  bindCanary,
  bindUserDataNote,
  canaryHoldFrom,
  createCanaryStreamGate,
  eventHasCanary,
  isStreamedCanaryEvent,
  mintCanary,
  OMIT_CANARY,
  redactCanary,
  redactCanaryText,
  scanTextForCanaryLeak,
  USER_CLOSE,
  USER_OPEN,
  wrapUserData,
};
