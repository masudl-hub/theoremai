/**
 * The application's turn wiring (`TurnWiring.prepare`) laid over the turn the handler builds.
 * The handler keeps the fields it owns; the application's stage handler and credentials go
 * first, and the handler's own run when the application's have nothing. An application's own
 * tool record, background service, and late results run with the session's, never in place of it.
 *
 * @module
 */

import type {
  LateResultsSource,
  NormalizedTurnRequest,
  StageHandler,
  TurnRequest,
} from '@theoremjs/agents';
import {
  type CredentialSource,
  isSealedSource,
  type JsonObject,
  type ToolBackgroundService,
  type ToolCredentialSource,
} from '@theoremjs/agents/kernel';
import { layeredToolCoordinator } from './tool-operations.ts';

/**
 * The app's refusal of a reply, in place of a turn: its own line is the reply, with no model run.
 * `host` is the app's own values for the line's block.
 */
export type ReplyRefusal = { refuse: { text: string; host?: JsonObject } };

/** The app's `prepare` for a turn the server runs: the turn, or its refusal of the reply. */
export type AppPrepare = (
  turn: NormalizedTurnRequest,
) => TurnRequest | ReplyRefusal | Promise<TurnRequest | ReplyRefusal>;

/** Whether `prepare` refused the reply. */
export function isRefusal(prepared: TurnRequest | ReplyRefusal): prepared is ReplyRefusal {
  return 'refuse' in prepared;
}

/** The fields a handler sets on every turn, which `prepare` cannot replace. */
export type HandlerOwned = Pick<
  TurnRequest,
  'profile' | 'pageExecution' | 'providerState' | 'signal'
>;

/**
 * The session's tool record, the handler's background service, and the session's late results,
 * which `prepare` can add to.
 */
export type HandlerTools = Pick<TurnRequest, 'execution' | 'background' | 'lateResults'>;

/** What the handler adds to a turn of its own: the session's credentials and its steering. */
export type HandlerTurnParts = {
  credentials: ToolCredentialSource;
  onStage?: StageHandler;
  /** Tells an open page when a call of the service it is given ends. */
  announce?: (service: ToolBackgroundService) => ToolBackgroundService;
};

/**
 * The turn to run: `turn` through the application's `prepare`, with the handler's own fields
 * kept, its credentials and steering after the application's, and the application's tool record
 * and background service, when it gives them, joined with the session's. The application's
 * refusal is returned as it is.
 */
export async function preparedTurn(
  prepare: AppPrepare | undefined,
  turn: NormalizedTurnRequest & HandlerOwned & HandlerTools,
  handler: HandlerTurnParts,
): Promise<TurnRequest | ReplyRefusal> {
  const app = prepare ? await prepare(turn) : turn;
  if (isRefusal(app)) return app;
  const owned: HandlerOwned = {
    profile: turn.profile,
    ...(turn.pageExecution ? { pageExecution: turn.pageExecution } : {}),
    ...(turn.providerState ? { providerState: turn.providerState } : {}),
    ...(turn.signal ? { signal: turn.signal } : {}),
  };
  const onStage = stagesInOrder(app.onStage, handler.onStage);
  const execution = toolsInOrder(app.execution, turn.execution);
  const background = backgroundInOrder(app.background, turn.background, handler.announce);
  const lateResults = lateResultsInOrder(app.lateResults, turn.lateResults);
  return {
    ...app,
    ...owned,
    ...(execution ? { execution } : {}),
    ...(background ? { background } : {}),
    ...(lateResults ? { lateResults } : {}),
    credentials: turnCredentials(app.credentials, handler.credentials),
    ...(onStage ? { onStage } : {}),
  };
}

/**
 * The application's tool record, then the session's. The application's decides each call; the
 * session's keeps the same call, so the page shows it and a resend reads it back.
 */
function toolsInOrder(
  app: TurnRequest['execution'],
  session: TurnRequest['execution'],
): TurnRequest['execution'] {
  if (!app || !session || app === session) return session ?? app;
  return layeredToolCoordinator(app, session);
}

/**
 * The application's background service in place of the handler's, told to the open page as the
 * handler's is. The handler's runs when the application gives none.
 */
function backgroundInOrder(
  app: ToolBackgroundService | undefined,
  own: ToolBackgroundService | undefined,
  announce: HandlerTurnParts['announce'],
): ToolBackgroundService | undefined {
  if (!app || app === own) return own;
  return announce ? announce(app) : app;
}

/**
 * The application's late results, then the session's, at each moment the turn asks. The session's
 * are the results it marked given, so an application's `prepare` cannot drop them.
 */
function lateResultsInOrder(
  app: LateResultsSource | undefined,
  session: LateResultsSource | undefined,
): LateResultsSource | undefined {
  if (!app || !session || app === session) return session ?? app;
  return async (moment) => [...(await app(moment)), ...(await session(moment))];
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
 * A sealed application source stands alone: its keys never reach this process, so the session
 * holds none beside it. Any other source goes before the session's.
 */
function turnCredentials(
  app: CredentialSource | undefined,
  session: ToolCredentialSource,
): CredentialSource {
  return app && isSealedSource(app) ? app : credentialsInOrder(app, session);
}

/**
 * The application's credentials, then the session's. A credential is saved where the slot
 * already lives: a refreshed token back to the application, a sign-in at a gate to the session.
 * A delete forgets the slot in both, so neither copy answers after it.
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
    delete: async (slot) => {
      await app.delete(slot);
      await session.delete(slot);
    },
    ...(secrets.clientSecret
      ? { clientSecret: async (clientId: string) => await secrets.clientSecret?.(clientId) }
      : {}),
  };
}
