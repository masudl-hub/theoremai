import type { ConversationCore, CoreContext } from '../../web/src/server/mod.ts';

/** An app's core that keeps every conversation under `sessionId`, whichever session the page has. */
export function underSession(core: ConversationCore, sessionId: string): ConversationCore {
  const on = (at: CoreContext): CoreContext => ({
    sessionId,
    signal: at.signal,
    get host() {
      return at.host;
    },
  });
  return {
    message: (at, args) => core.message(on(at), args),
    checkMessage: (at, args) => core.checkMessage(on(at), args),
    answer: (at, body) => core.answer(on(at), body),
    wake: (at, args) => core.wake(on(at), args),
    followUp: (at, args) => core.followUp(on(at), args),
    release: (at, args) => core.release(on(at), args),
    read: (at, args) => core.read(on(at), args),
    rewind: (at, args) => core.rewind(on(at), args),
    follow: (at, args) => core.follow(on(at), args),
    subscribe: (at, changed) => core.subscribe(on(at), changed),
    steer: (at, args) => core.steer(on(at), args),
    stop: (at, args) => core.stop(on(at), args),
  };
}
