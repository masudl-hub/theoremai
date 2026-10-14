import type { TheoremError, TurnEvent } from '@theoremjs/agents';
import {
  applyTurnEventsToSession,
  type ComposerProfileInterface,
  gatedToolFromEvents,
  type InterfaceTurnSession,
  type TranscriptBlock,
} from '@theoremjs/agents/interface';
import type { ChatLineSink, ConversationLine } from './transport.ts';
import { foldAssistantTurn } from './turn-client.ts';

/**
 * The session once a reply's events are in: a reply that waits on a gate
 * keeps its events beside the transcript until the gate settles; any other is over.
 */
export function sessionAfter(
  session: InterfaceTurnSession,
  events: readonly TurnEvent[],
): InterfaceTurnSession {
  const applied = applyTurnEventsToSession(session, events);
  const gatedTool = gatedToolFromEvents(events);
  if (gatedTool) return { ...applied, gatedTool, assistantEvents: [...events] };
  return {
    ...applied,
    gatedTool: null,
    assistantEvents: [],
    pendingUserDraft: null,
    toolSnapshot: undefined,
    promotedToolIds: [],
  };
}

/** Where a run shows itself as it streams: the reply so far, and each line the stream left out. */
export type StreamView = {
  blocks(blocks: TranscriptBlock[]): void;
  /** A `malformed` line: left out, and the reply goes on. */
  skipped(error: TheoremError): void;
};

/**
 * Streams into `events`, which the caller owns, so a stream that fails still
 * leaves what it delivered. A `conversation` line goes to `onConversation`. An
 * `unsupported` line is the host's to read on its own transport, and a
 * `malformed` one goes to `view.skipped`: neither enters the reply.
 */
export function streamFoldedTurn(args: {
  iface: ComposerProfileInterface;
  view: StreamView;
  /** Seeded by the caller, and filled as the stream delivers. */
  events: TurnEvent[];
  /** The page adopts each ref from its transport; a run reads them only to know its message posted. */
  onConversation?(line: ConversationLine): void;
  stream: (onLine: ChatLineSink) => Promise<void>;
}): Promise<void> {
  return args.stream((line) => {
    if (line.type === 'conversation') {
      args.onConversation?.(line);
      return;
    }
    if (line.type === 'unsupported') return;
    if (line.type === 'malformed') {
      args.view.skipped(line.error);
      return;
    }
    args.events.push(line);
    args.view.blocks(foldAssistantTurn(args.iface, args.events));
  });
}

/** `blocks` with its last `turn-done` carrying the reply's work. */
export function stampWorked(
  blocks: TranscriptBlock[],
  worked: { workedMs: number; endedAt: number },
): TranscriptBlock[] {
  const last = blocks.findLastIndex((block) => block.kind === 'turn-done');
  if (last < 0) return blocks;
  return blocks.map((block, index) => (index === last ? { ...block, ...worked } : block));
}
