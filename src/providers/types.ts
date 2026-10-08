import type { TheoremError } from '../guardrails/error.ts';
import type { InteractionPart, KeyVault, ProviderEvent } from '../kernel/types.ts';
import type { Wait } from './shared/retry.ts';

/** Settings for the OpenAI-compatible gateway provider: its base URL, the site URL and name sent as `HTTP-Referer` and `X-Title`, and the fetch and wait to use. */
export interface OpenAiGatewayConfig {
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  fetch?: typeof fetch;
  wait?: Wait;
}

/** Settings for a local OpenAI-compatible server: its base URL and an optional fetch. */
export interface LocalProviderConfig {
  /** e.g. `http://127.0.0.1:11434` for Ollama. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** Internal codec settings resolved by a registered adapter. */
export type OpenAiGatewayTransport = OpenAiGatewayConfig & { vault?: KeyVault };
export type LocalTransport = LocalProviderConfig & { vault?: KeyVault };

/** Where a live model is in its reply when a frame arrives. */
export type LiveTurnPhase = 'streaming' | 'complete' | 'abort';

/** Tape row: setup on the pinned key was refused for quota, so the session opens on the fallback slot. */
export const LIVE_FALLBACK_ROW = 'ws_fallback';

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
      events: ProviderEvent[];
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
  /** Text, audio or video from the user, as it arrives. */
  sendInput(input: InteractionPart): void;
  /** The result of a tool call the model made. */
  sendToolResponse(callId: string, name: string, output: unknown, parts?: InteractionPart[]): void;
  batches(): AsyncGenerator<LiveQueueItem>;
  close(code?: number, reason?: string): void;
}
