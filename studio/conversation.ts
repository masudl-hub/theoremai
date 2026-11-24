/**
 * Where a chat's replies run: the application's own conversation core, in place of the studio's.
 * A setup file offers one as `export const conversation`, so a studio chat on that agent is the
 * app's own conversation: its message, its reply and its follow-up are saved as the app saves
 * them on its other channels.
 *
 * @module
 */

import type { ConversationCore, TheoremHandlerOptions } from '@theoremjs/web/server';

/**
 * The app's conversation for one agent. `core` runs every reply, read, rewind, stop and steer the
 * page asks for. `intake` and `onContinue` are the ones the app's own `createTheoremHandler`
 * takes: the save of each message the page sends, and who runs the next reply when one ends with
 * items that wait. Leave `onContinue` out and the chat is let go when a reply ends, as a handler
 * with none lets it go.
 */
export interface StudioConversation {
  core: ConversationCore;
  intake?: TheoremHandlerOptions['intake'];
  onContinue?: TheoremHandlerOptions['onContinue'];
}

/**
 * What a setup file exports as `conversation`: the agent's conversation, by the agent's id, or
 * `undefined` for an agent that keeps the studio's own. The studio calls it once for each agent
 * that holds a chat, as it loads the project and after `register`.
 */
export type StudioConversations = (profileId: string) => StudioConversation | undefined;
