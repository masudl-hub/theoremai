import type { TurnHistoryMessage } from '../kernel/turn-events.ts';
import { DETECT_RULES } from './rules.ts';
import type { GuardrailHit, Provenance, ToolOrigin } from './types.ts';

/** The closing tag of the fence a tool result is wrapped in. */
const TOOL_CLOSE = '</tool_data>';

const FENCE_OPEN = /^<tool_data tool="([^"]*)" origin="([^"]*)"( advisory="[^"]*")?>\n/gm;

/** What a fence from `wrapToolData` says of the text inside it. */
export interface ToolDataRead {
  provenance: Provenance;
  suspicious: GuardrailHit[];
  /** The result as `composeToolText` joined it. */
  text: string;
}

/**
 * Reads each whole fence in a message. A sign-in note can stand before one, and a late-result
 * message holds one for each result. `stripToolFences` has taken any forged tag out of a body, so
 * what a tag says is the kernel's.
 */
function readToolData(content: string): ToolDataRead[] {
  const reads: ToolDataRead[] = [];
  for (const open of content.matchAll(FENCE_OPEN)) {
    const [opening, tool = '', origin = '', advised] = open;
    const start = open.index + opening.length;
    const end = content.indexOf(`\n${TOOL_CLOSE}`, start);
    if (end < 0) continue;
    const body = content.slice(start, end);
    reads.push({
      provenance: { origin: origin as ToolOrigin, tool, depth: origin === 'delegated' ? 2 : 1 },
      suspicious: advised ? [{ rule: DETECT_RULES.injection, severity: 'high' as const }] : [],
      text: advised ? body.slice(body.indexOf('\n') + 1) : body,
    });
  }
  return reads;
}

/**
 * Whether a role `user` message holds tool results that `TurnRequest.lateResults` gave. It is no one's
 * word to the model. A person who types a fence only makes their own reply stricter.
 */
function isLateResult(message: TurnHistoryMessage): boolean {
  return (
    message.role === 'user' &&
    message.content !== undefined &&
    readToolData(message.content).length > 0
  );
}

/**
 * The history message `TurnRequest.lateResults` lands. Its metadata names the calls it holds, and
 * says when it landed inside a reply rather than opening one.
 */
function lateResultsMessage(
  text: string,
  operationIds: readonly string[],
  inReply: boolean,
): TurnHistoryMessage {
  return {
    role: 'user',
    content: text,
    metadata: { lateResults: [...operationIds], ...(inReply ? { lateResultsInReply: true } : {}) },
  };
}

/** Whether `message` is a late result that landed inside a reply. Such a message opens no reply. */
function landedInReply(message: TurnHistoryMessage): boolean {
  return isLateResult(message) && message.metadata?.lateResultsInReply === true;
}

/** The calls whose late results a history message holds. */
function lateResultIds(message: TurnHistoryMessage): string[] {
  const ids = message.metadata?.lateResults;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export { isLateResult, landedInReply, lateResultIds, lateResultsMessage, readToolData, TOOL_CLOSE };
