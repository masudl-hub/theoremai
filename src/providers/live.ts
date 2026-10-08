/**
 * The live protocols the kernel can open a session on. `runSession` reaches a provider's socket
 * and its wire shapes only through here, so the engine names no provider.
 *
 * @module
 */
import type { KeyVault, ProviderCompleteRequest, TurnHistoryMessage } from '../kernel/types.ts';
import type { GeminiOptions } from './google/keys.ts';
import { liveFrameInput, liveFunctionResponsePayload } from './google/live/framing.ts';
import { type OpenLiveWebSocket, openGoogleLiveSession } from './google/live/session.ts';
import type { LiveConnection } from './types.ts';

/** What a host gives the live providers: the one vault, and each provider's own settings. */
export interface LiveProviderOptions {
  /** The host's keys by slot; the session uses the slots its profile names. */
  vault: KeyVault;
  gemini?: GeminiOptions;
}

// why: One provider speaks a live protocol today; a second is picked here, by the request's protocol.

/** Opens the socket for a live request and sends its setup. */
export function openLiveSession(
  req: ProviderCompleteRequest,
  options: LiveProviderOptions,
  openWebSocket?: OpenLiveWebSocket,
): Promise<LiveConnection> {
  return openGoogleLiveSession(req, { ...options.gemini, vault: options.vault }, openWebSocket);
}

/** What one frame sent on a live socket gave the model to read; setup and control frames give none. */
export function liveSentInput(frame: Record<string, unknown>): TurnHistoryMessage[] {
  return liveFrameInput(frame);
}

/** A tool result as the model reads it back on a live socket. */
export function liveToolReadBack(output: unknown): string {
  return JSON.stringify(liveFunctionResponsePayload(output));
}
