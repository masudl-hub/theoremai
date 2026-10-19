import type { TheoremError } from '../guardrails/error.ts';
import type { InteractionPart, ModelEvent } from '../kernel/types.ts';

/** Where a live model is in its reply when a frame arrives. */
export type LiveTurnPhase = 'streaming' | 'complete' | 'abort';

/** Tape row: the first key was refused for quota, so the call starts again on the fallback slot. */
export const KEY_FALLBACK_ROW = 'key_fallback';

/** The provider's warning before it closed a live socket. */
export interface LiveGoAway {
  timeLeftMs?: number;
  /** Milliseconds from the last warning to the close. */
  closedAfterMs: number;
}

/** One thing a live socket received. `row` is the parsed frame, so the kernel records it beside the events it produced. */
export type LiveQueueItem =
  | {
      type: 'batch';
      events: ModelEvent[];
      turnPhase: LiveTurnPhase;
      row: Record<string, unknown>;
    }
  | { type: 'row'; row: Record<string, unknown> }
  | { type: 'error'; error: Error; row?: Record<string, unknown> }
  /** `error` is set when the close was not normal; `goAway` when the provider warned first. */
  | { type: 'closed'; code: number; reason: string; error?: TheoremError; goAway?: LiveGoAway };

/**
 * An open live socket, in the kernel's terms: the setup the session was opened with, what the
 * session sends the model, `batches` for what it receives, and `close`. A send on a socket that is
 * no longer open is dropped.
 */
export interface LiveConnection {
  readonly setup: Record<string, unknown>;
  flush?(): Promise<void>;
  /** Text the model reads without it ending the user's turn. */
  sendContext(text: string): void;
  /** Text, audio, or video from the user, as it arrives. */
  sendInput(input: InteractionPart): void;
  /** The result of a tool call the model made. */
  sendToolResponse(callId: string, name: string, output: unknown, parts?: InteractionPart[]): void;
  batches(): AsyncGenerator<LiveQueueItem>;
  close(code?: number, reason?: string): void;
}
