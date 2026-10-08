import type { SessionRequest, TurnContext, TurnInput } from '@theoremjs/agents';
import type { LiveOpenMessage } from '../client/live-messages.ts';
import type { TheoremTurnInput } from '../client/transport.ts';

/** The page's context as the client's and the host's as the server's; nothing when neither gave any. */
export function turnContext(client: unknown, server?: unknown): TurnContext | undefined {
  const context = {
    ...(client === undefined ? {} : { client }),
    ...(server === undefined ? {} : { server }),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

/** A turn input off the wire as the kernel takes it: the page's context is the client's. */
export function kernelTurnInput(input: TheoremTurnInput, server?: unknown): TurnInput {
  const { context: client, ...rest } = input;
  const context = turnContext(client, server);
  return context ? { ...rest, context } : rest;
}

/**
 * What a live call's first message asks of the session, as `runSession` takes
 * it: the page's context is the client's, and `server` is the host's own.
 */
export function liveSessionOpen(
  open: LiveOpenMessage,
  server?: unknown,
): Pick<SessionRequest, 'slots' | 'context' | 'providerState' | 'awayMs'> {
  const context = turnContext(open.context, server);
  return {
    ...(open.slots ? { slots: open.slots } : {}),
    ...(context ? { context } : {}),
    ...(open.resume
      ? { providerState: open.resume.providerState, awayMs: open.resume.awayMs }
      : {}),
  };
}
