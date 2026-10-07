import type { TurnContext, TurnInput } from '@theoremjs/agents';
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
