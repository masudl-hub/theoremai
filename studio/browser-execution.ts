import { createTheoremSessionBoundary } from '../react/src/server/session-boundary.ts';
import { createMemorySessionStore, DEFAULT_OPERATION_RETENTION_MS } from '../react/src/server/session-store.ts';
import { sessionStateStore } from '../react/src/server/session-authority.ts';
import { resolveSessionLimits } from '../react/src/server/session-limits.ts';
import { createMemoryPageToolBroker, sessionPageDispatch } from '../react/src/server/page-dispatch.ts';
import { sessionToolCoordinator } from '../react/src/server/tool-operations.ts';

export function browserExecution() {
  const id = crypto.randomUUID();
  const memory = createMemorySessionStore();
  const boundary = createTheoremSessionBoundary({ request: new Request('https://studio.local'), session: () => id, sessionStore: memory });
  const store = sessionStateStore(memory, 30 * 60_000,
    DEFAULT_OPERATION_RETENTION_MS, resolveSessionLimits());
  const page = sessionPageDispatch(store, id, createMemoryPageToolBroker());
  return { boundary, execution: sessionToolCoordinator(store, id), pageExecution: page.execution, pageResult: page.answer };
}
