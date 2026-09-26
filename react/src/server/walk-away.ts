/**
 * A message that walks away from the calls its reply paused on, the same on
 * every host (`createTheoremHandler`, the playground). The message's history
 * leaves exactly those calls open; each settles cancelled, its events stream
 * ahead of the reply, and the model reads each answer before the message.
 *
 * @module
 */

import { TheoremError, type TurnEvent, type TurnInput } from '../../../mod.ts';
import { answerOpenToolCalls, assertOpenToolCalls, settlesToolCall } from '../../../src/interface/mod.ts';

/** Refuses a walk-away its history does not match, before any gate is answered. */
export function checkWalkAway(input: TurnInput, abandon: readonly string[]): void {
  assertOpenToolCalls(input.history ?? [], abandon);
}

/** One walked-away call: its id, and the run that settles it (`invokeTool` with the abandoned resume). */
export type WalkedAwayCall = { callId: string; events: AsyncIterable<TurnEvent> };

/**
 * Streams each call's tool events as it settles; each run's `done` stays with
 * that run. Returns `input` with every call answered in its history, or
 * undefined when a run failed: its `error` event went out and ends the reply.
 */
export async function* walkAway(
  input: TurnInput,
  calls: readonly WalkedAwayCall[],
): AsyncGenerator<TurnEvent, TurnInput | undefined> {
  const answers = new Map<string, string>();
  for (const call of calls) {
    for await (const event of call.events) {
      if (event.type === 'error') {
        yield event;
        return undefined;
      }
      if (event.type !== 'tool') continue;
      yield event;
      const readBack = settlesToolCall(event, call.callId) ? event.tool.readBack : undefined;
      if (readBack !== undefined) answers.set(call.callId, readBack);
    }
    if (!answers.has(call.callId)) {
      // lexicon-exempt: internal diagnostic; the user reads error.internal
      throw new TheoremError('internal', `walked-away call ${call.callId} ended without settling`);
    }
  }
  return { ...input, history: answerOpenToolCalls(input.history ?? [], answers) };
}
