/**
 * What a chat's session holds outlives the load that wrote it. A load is a process the studio
 * replaces, so the gates, answers and detached calls of its chats live here, in the process that
 * stays, and a load reaches them over its own server with a token only it was given. They stay in
 * memory: a session may hold secrets, and nothing of it reaches disk.
 *
 * A call that detached runs on in the load that started it, so the studio keeps a replaced load
 * until its calls end, and what they answer lands here for the load that took over.
 *
 * @module
 */

import {
  createMemorySessionStore,
  type TheoremSessionState,
  type TheoremSessionStore,
} from '@theoremjs/web/server';

/** What a load needs to reach the kept sessions. `scope` keeps a load's chats from another kind's. */
export interface KeptSessionLink {
  url: string;
  token: string;
  /** Which load writes, so a detached call is known to run in it. */
  load: string;
  scope: string;
}

export interface KeptSessions {
  token: string;
  /** Answers a load's read or write of a session. */
  answer(request: Request): Promise<Response>;
  /** When the calls detached in `load` have ended; undefined when none is going on. */
  callsEnd(load: string): Promise<void> | undefined;
  /** The load's process ended: a call it left running has no known end. */
  loadEnded(load: string): Promise<void>;
}

type KeptSessionAsk = {
  sessionId: string;
  write?: { expected: string | null; next: TheoremSessionState; load: string };
};

export function createKeptSessions(): KeptSessions {
  // why: a session here lasts as long as the studio does, so the store takes no limits.
  const store = createMemorySessionStore();
  const token = crypto.randomUUID();
  /** Each session's detached calls, by operation, with the load each runs in. */
  const detached = new Map<string, Map<string, string>>();
  const waiting = new Map<string, { ended: Promise<void>; end: () => void }>();
  const isRunning = (load: string) =>
    [...detached.values()].some((calls) => [...calls.values()].includes(load));
  const note = (sessionId: string, state: TheoremSessionState, load: string) => {
    const calls = detached.get(sessionId) ?? new Map<string, string>();
    detached.set(sessionId, calls);
    for (const [id, operation] of Object.entries(state.operations))
      if (operation.status === 'background' && !calls.has(id)) calls.set(id, load);
    for (const [id, owner] of calls) {
      if (state.operations[id]?.status === 'background') continue;
      calls.delete(id);
      if (!isRunning(owner)) {
        waiting.get(owner)?.end();
        waiting.delete(owner);
      }
    }
  };
  /** Takes the load's calls out of a session; retried, as a load may be writing it too. */
  const forget = async (sessionId: string, load: string) => {
    for (;;) {
      const snapshot = await store.load(sessionId);
      if (!snapshot) return;
      const operations = Object.fromEntries(
        Object.entries(snapshot.state.operations).filter(
          ([id]) => detached.get(sessionId)?.get(id) !== load,
        ),
      );
      const next = { ...snapshot.state, operations };
      const write = await store.compareAndSwap(sessionId, snapshot.revision, next);
      if (write.written) return note(sessionId, next, load);
    }
  };
  return {
    token,
    answer: async (request) => {
      if (request.headers.get('authorization') !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      const { sessionId, write } = (await request.json()) as KeptSessionAsk;
      if (!write) return Response.json({ snapshot: await store.load(sessionId) });
      const answer = await store.compareAndSwap(sessionId, write.expected, write.next);
      if (answer.written) note(sessionId, write.next, write.load);
      return Response.json(answer);
    },
    callsEnd: (load) => {
      if (!isRunning(load)) return undefined;
      const held = waiting.get(load);
      if (held) return held.ended;
      let end = () => {};
      const ended = new Promise<void>((done) => {
        end = done;
      });
      waiting.set(load, { ended, end });
      return ended;
    },
    loadEnded: async (load) => {
      const sessions = [...detached].filter(([, calls]) => [...calls.values()].includes(load));
      await Promise.all(sessions.map(([sessionId]) => forget(sessionId, load)));
    },
  };
}

/** The kept sessions as a load's store, under `link.scope` and the profile's id. */
export function keptSessionStore(link: KeptSessionLink, profileId: string): TheoremSessionStore {
  const key = (sessionId: string) => `${link.scope}:${profileId}:${sessionId}`;
  const ask = async (asked: KeptSessionAsk) => {
    const response = await fetch(link.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${link.token}` },
      body: JSON.stringify(asked),
    });
    // The studio said what the status means; a session's text never goes in an error.
    if (!response.ok) throw new Error(`The studio's kept sessions answered ${response.status}.`);
    return response.json();
  };
  return {
    load: async (sessionId) => (await ask({ sessionId: key(sessionId) })).snapshot,
    compareAndSwap: (sessionId, expected, next) =>
      ask({ sessionId: key(sessionId), write: { expected, next, load: link.load } }),
  };
}
