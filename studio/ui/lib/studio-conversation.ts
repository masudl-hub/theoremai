/**
 * Each agent's preview conversation, kept in this tab's records beside the workspace so a reload
 * resumes it. What is kept is the conversation's ref: the conversation sealed with a key, which
 * opens only where that key is. A run in the page seals with the tab's own key, which stays in the
 * tab's sessionStorage and never reaches the browser's keep; the hosted demo seals on its server.
 */
import { newConversationKey } from '../../conversation-key.ts';
import { CHAT_PREFIX, isRecord, session, tabSession } from './studio-session.ts';

/** Who sealed a kept ref, so it is offered only to a run that can open it. */
export type ChatSealer = 'page' | 'demo';

/** The tab's key for the conversations its page runs seal. */
const PAGE_KEY = 'theorem.studio.chat-key';

/** The key, while the tab keeps none: it lasts as long as the page. */
let pageKeyHeld: string | undefined;

/**
 * The key this tab's page runs seal their conversations with. It is kept in the tab beside the
 * refs it opens, so both go when the tab does. A new key forgets the refs the last one sealed.
 */
export function pageConversationKey(): string {
  const store = tabSession();
  try {
    const kept = store?.getItem(PAGE_KEY);
    if (kept) return kept;
  } catch {
    // Storage refused the read: the page holds its own key.
  }
  if (pageKeyHeld) return pageKeyHeld;
  const key = newConversationKey();
  pageKeyHeld = key;
  forgetSealedBy('page');
  try {
    store?.setItem(PAGE_KEY, key);
  } catch {
    // Over quota or blocked: the key lasts as long as the page, and so do its chats.
  }
  return key;
}

/** A kept ref, when `raw` is one. */
function keptRef(raw: string): { sealer: ChatSealer; ref: string } | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.ref !== 'string') return undefined;
    const { sealer } = value;
    return sealer === 'page' || sealer === 'demo' ? { sealer, ref: value.ref } : undefined;
  } catch {
    return undefined;
  }
}

/** Forgets every ref `sealer` sealed: none of them opens any more. */
function forgetSealedBy(sealer: ChatSealer): void {
  const store = session();
  for (const key of store?.keys() ?? []) {
    if (!key.startsWith(CHAT_PREFIX)) continue;
    const raw = store?.getItem(key);
    if (raw && keptRef(raw)?.sealer === sealer) store?.removeItem(key);
  }
}

/**
 * Keeps an agent's conversation ref. The ref holds the whole conversation, its media too: one the
 * browser refuses to keep is forgotten, with the agent's last kept ref. Never throws.
 */
export function saveConversation(agentKey: string, sealer: ChatSealer, ref: string): void {
  session()?.setItem(`${CHAT_PREFIX}${agentKey}`, JSON.stringify({ sealer, ref }));
}

/**
 * An agent's kept ref, when `sealer` sealed it. Anything else kept under the agent (a
 * conversation kept before refs) is forgotten, so it holds no room.
 */
export function restoreConversation(agentKey: string, sealer: ChatSealer): string | undefined {
  const store = session();
  const key = `${CHAT_PREFIX}${agentKey}`;
  const raw = store?.getItem(key);
  if (!raw) return undefined;
  const kept = keptRef(raw);
  if (!kept) store?.removeItem(key);
  return kept?.sealer === sealer ? kept.ref : undefined;
}

/** Forgets one agent's conversation, or every agent's. */
export function clearConversation(agentKey?: string): void {
  const store = session();
  for (const key of store?.keys() ?? []) {
    if (agentKey === undefined ? key.startsWith(CHAT_PREFIX) : key === `${CHAT_PREFIX}${agentKey}`)
      store?.removeItem(key);
  }
}
