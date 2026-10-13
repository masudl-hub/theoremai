import type { InteractionPart, TurnHistoryMessage } from '../../kernel/types.ts';

/** What stands in a tool result where a file it cannot hold was. */
function carriedFileMarker(part: InteractionPart): InteractionPart {
  return { type: 'text', text: `[${part.type}: sent in the next message]` };
}

/** What leads the files of one tool result in the user message that carries them. */
function carriedFilesLead(msg: TurnHistoryMessage): InteractionPart {
  const from = msg.name ? `the ${msg.name} result` : 'a tool result';
  return { type: 'text', text: `Files from ${from}:` };
}

/**
 * History for a wire whose tool result holds only the `holds` part types. Every
 * other file leaves a marker in its place and follows the run of tool results in
 * one user message, so the results of a parallel call stay together.
 */
export function withCarriedToolFiles(
  messages: readonly TurnHistoryMessage[],
  holds: ReadonlySet<InteractionPart['type']>,
): TurnHistoryMessage[] {
  const out: TurnHistoryMessage[] = [];
  let carried: InteractionPart[] = [];
  const flush = () => {
    if (carried.length === 0) return;
    out.push({ role: 'user', parts: carried });
    carried = [];
  };
  for (const msg of messages) {
    if (msg.role !== 'tool') {
      flush();
      out.push(msg);
      continue;
    }
    const files = (msg.parts ?? []).filter((part) => !holds.has(part.type));
    if (files.length === 0) {
      out.push(msg);
      continue;
    }
    out.push({
      ...msg,
      parts: (msg.parts ?? []).map((part) =>
        holds.has(part.type) ? part : carriedFileMarker(part),
      ),
    });
    carried.push(carriedFilesLead(msg), ...files);
  }
  flush();
  return out;
}
