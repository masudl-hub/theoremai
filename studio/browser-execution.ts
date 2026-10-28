import {
  createMemoryPageToolBroker,
  createMemorySessionStore,
  createTheoremSessionBoundary,
  DEFAULT_OPERATION_RETENTION_MS,
  sessionPageDispatch,
  sessionStateStore,
  sessionToolCoordinator,
} from '@theoremjs/web/server';

export function browserExecution() {
  const id = crypto.randomUUID();
  const memory = createMemorySessionStore();
  const boundary = createTheoremSessionBoundary({
    request: new Request('https://studio.local'),
    session: () => id,
    sessionStore: memory,
  });
  const store = sessionStateStore(memory, undefined, DEFAULT_OPERATION_RETENTION_MS);
  const page = sessionPageDispatch(store, id, createMemoryPageToolBroker());
  return {
    boundary,
    execution: sessionToolCoordinator(store, id),
    pageExecution: page.execution,
    pageResult: page.answer,
  };
}
