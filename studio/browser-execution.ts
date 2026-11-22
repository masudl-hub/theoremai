import {
  createMemoryPageToolBroker,
  createMemorySessionStore,
  createTheoremSessionBoundary,
  sessionPageDispatch,
  sessionStateStore,
  sessionToolCoordinator,
} from '@theoremjs/web/server';
import { STUDIO_BACKGROUND, STUDIO_OPERATION_RETENTION_MS } from './runtime-scope.ts';

export function browserExecution() {
  const id = crypto.randomUUID();
  const memory = createMemorySessionStore();
  const boundary = createTheoremSessionBoundary({
    request: new Request('https://studio.local'),
    session: () => id,
    sessionStore: memory,
    operationRetentionMs: STUDIO_OPERATION_RETENTION_MS,
    pageStatesTurn: true,
  });
  const store = sessionStateStore(memory, undefined, STUDIO_OPERATION_RETENTION_MS);
  const page = sessionPageDispatch(store, id, createMemoryPageToolBroker());
  return {
    boundary,
    execution: sessionToolCoordinator(store, id),
    pageExecution: page.execution,
    background: STUDIO_BACKGROUND,
    pageResult: page.answer,
  };
}
