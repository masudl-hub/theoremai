/**
 * `guardrails.detect` on a reply once it has ended. The stream gate
 * (`progressive-yield.ts`) already reported and replaced what it released; this
 * reads the reply whole, so a match the stream held back, or one in the
 * structured output, meets the action the profile set before the reply crosses.
 *
 * @module
 */

import { mapStrings } from '../kernel/engine/tree.ts';
import type { Boundary } from './boundaries.ts';
import {
  type Detection,
  type DetectScope,
  detectAt,
  detectEvent,
  detectReads,
} from './detect-at.ts';
import type { ResolvedDetect } from './detectors.ts';
import type { GuardrailEvent, GuardrailHit } from './event-schemas.ts';
import { EGRESS_RULES } from './rules.ts';
import { textForScan } from './serialize.ts';
import type { OutboundPayload } from './types.ts';

/** The boundaries a turn's reply crosses: its text, and its structured output. */
const TURN_REPLY = ['reply', 'reply_structured'] as const satisfies readonly Boundary[];

/** A reply read whole at its boundaries. */
interface ReplyRead {
  /** The reply to send on: every match set to `redact` replaced. */
  payload: OutboundPayload;
  /** Whether `payload.text` differs from the text as written. */
  rewritten: boolean;
  /** One event for each boundary with something to report. */
  events: GuardrailEvent[];
  /** Set when a match blocks: the reply does not cross. */
  blocked?: GuardrailHit[];
}

type Found = Pick<Detection, 'action' | 'hits'>;

/** The structured output with each match in a string replaced, or what stops it crossing. */
function readStructured(
  structured: unknown,
  detect: ResolvedDetect,
  scope: DetectScope,
): Found & { value?: unknown } {
  if (!detectReads(['reply_structured'], detect)) {
    return { action: 'allow', hits: [], value: structured };
  }
  const scan = textForScan(structured);
  if (scan.unscannable) {
    // why: Cannot inspect it, so cannot vouch for it. Fail closed.
    return { action: 'block', hits: [{ rule: EGRESS_RULES.unscannable, severity: 'high' }] };
  }
  const found = detectAt(scan.text, 'reply_structured', detect, scope);
  if (found.action !== 'redact') {
    return { action: found.action, hits: found.hits, value: structured };
  }
  const value = mapStrings(
    structured,
    (leaf) => detectAt(leaf, 'reply_structured', detect, scope).text ?? '',
  );
  const left = detectAt(textForScan(value).text, 'reply_structured', detect, scope).action;
  // why: A match in a key, or one that runs across values, has no string to replace: it does not cross.
  if (left === 'redact' || left === 'block') return { action: 'block', hits: found.hits };
  return { action: 'redact', hits: found.hits, value };
}

/**
 * Reads a reply's text at `boundary`, and its structured output at
 * `reply_structured`. A flag in text the stream released was reported then, so
 * it is reported here only when the stream `withheld` the reply. `scope` is
 * what the detectors of what is the profile's own read of the turn.
 */
function readReply(
  written: OutboundPayload,
  detect: ResolvedDetect,
  {
    boundary,
    withheld,
    scope = {},
  }: { boundary: 'reply' | 'live_reply'; withheld: boolean; scope?: DetectScope },
): ReplyRead {
  const text = detectAt(written.text, boundary, detect, scope);
  const structured =
    written.structured === undefined
      ? undefined
      : readStructured(written.structured, detect, scope);
  const events = [
    text.action === 'flag' && !withheld ? undefined : detectEvent(boundary, text),
    structured ? detectEvent('reply_structured', structured) : undefined,
  ].filter((event) => event !== undefined);
  const blocked = [text, structured].flatMap((found) =>
    found?.action === 'block' ? found.hits : [],
  );
  return {
    payload: {
      text: text.text ?? written.text,
      ...(structured ? { structured: structured.value } : {}),
    },
    rewritten: text.action === 'redact',
    events,
    ...(blocked.length > 0 ? { blocked } : {}),
  };
}

/**
 * The hits a reply stays stopped on: this reading's block, or else a leak the
 * stream `stopped` on that this reading does not find. The two are out of
 * step then, and the stream's finding stands.
 */
function standingBlock(
  read: ReplyRead,
  stopped: readonly GuardrailHit[] = [],
): GuardrailHit[] | undefined {
  if (read.blocked) return read.blocked;
  const reread = new Set(read.events.flatMap((event) => event.hits.map((hit) => hit.rule)));
  const unread = stopped.filter((hit) => !reread.has(hit.rule));
  return unread.length > 0 ? unread : undefined;
}

export type { ReplyRead };
export { readReply, standingBlock, TURN_REPLY };
