/**
 * The application's turn wiring (`TurnWiring.prepare`) laid over the turn the handler builds.
 * The handler keeps the fields it owns; the application's stage handler and credentials go
 * first, and the handler's own run when the application's have nothing.
 *
 * @module
 */

import type {
  NormalizedTurnRequest,
  StageHandler,
  TurnRequest,
  TurnWiring,
} from '@theoremjs/agents';
import type { ToolCredentialSource } from '@theoremjs/agents/kernel';

/** The fields a handler sets on every turn, which `prepare` cannot replace. */
export type HandlerOwned = Pick<
  TurnRequest,
  'profile' | 'execution' | 'pageExecution' | 'providerState' | 'signal'
>;

/** What the handler adds to a turn of its own: the session's credentials and its steering. */
export type HandlerTurnParts = {
  credentials: ToolCredentialSource;
  onStage?: StageHandler;
};

/**
 * The turn to run: `turn` through the application's `prepare`, with the handler's own fields
 * kept, and its credentials and steering after the application's.
 */
export async function preparedTurn(
  prepare: TurnWiring['prepare'],
  turn: NormalizedTurnRequest & HandlerOwned,
  handler: HandlerTurnParts,
): Promise<TurnRequest> {
  const app = prepare ? await prepare(turn) : turn;
  const owned: HandlerOwned = {
    profile: turn.profile,
    ...(turn.execution ? { execution: turn.execution } : {}),
    ...(turn.pageExecution ? { pageExecution: turn.pageExecution } : {}),
    ...(turn.providerState ? { providerState: turn.providerState } : {}),
    ...(turn.signal ? { signal: turn.signal } : {}),
  };
  const onStage = stagesInOrder(app.onStage, handler.onStage);
  return {
    ...app,
    ...owned,
    credentials: credentialsInOrder(app.credentials, handler.credentials),
    ...(onStage ? { onStage } : {}),
  };
}

/**
 * The application's stage handler, then the handler's own when the application's asks for
 * nothing. What the second one would have done waits for the next stage that allows it.
 */
export function stagesInOrder(
  app: StageHandler | undefined,
  own: StageHandler | undefined,
): StageHandler | undefined {
  if (!app || !own) return app ?? own;
  return async (ctx) => (await app(ctx)) ?? (await own(ctx));
}

/**
 * The application's credentials, then the session's. A credential is saved where the slot
 * already lives: a refreshed token back to the application, a sign-in at a gate to the session.
 */
export function credentialsInOrder(
  app: ToolCredentialSource | undefined,
  session: ToolCredentialSource,
): ToolCredentialSource {
  if (!app) return session;
  // why: Called as a method: an application's source may keep its secrets on `this`.
  const secrets = app.clientSecret ? app : session;
  return {
    get: async (slot) => (await app.get(slot)) ?? (await session.get(slot)),
    set: async (slot, credential) =>
      (await app.get(slot)) ? await app.set(slot, credential) : await session.set(slot, credential),
    ...(secrets.clientSecret
      ? { clientSecret: async (clientId: string) => await secrets.clientSecret?.(clientId) }
      : {}),
  };
}
