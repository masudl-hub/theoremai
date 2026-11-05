import type { TheoremChatHandle } from '@theoremjs/react/ui';
import type { RefObject } from 'react';

/**
 * Sends `text` once the chat takes it: a chat just mounted takes nothing until it has described
 * its agent. Null when it took nothing in `ms`, or `signal` aborted.
 */
export async function sendWhenReady(
  chat: RefObject<TheoremChatHandle | null>,
  text: string,
  signal: AbortSignal,
  ms = 10_000,
) {
  const until = Date.now() + ms;
  while (!signal.aborted && Date.now() < until) {
    const sent = await chat.current?.send(text);
    if (sent) return sent;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return null;
}
