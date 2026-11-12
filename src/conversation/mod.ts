/**
 * The conversation layer: one hold at a time reads a conversation's inbox, and an item reaches the
 * model only through the hold, told once the reply that read it is saved. The app gives the
 * storage (a {@link ConversationInbox}) and the rule for what may be told now (an
 * {@link InboxPolicy}); {@link runConversation} runs each reply under a hold. No HTTP, no
 * transcript. The scenarios every inbox must pass are in `@theoremjs/agents/conversation/testing`.
 *
 * @module
 */

export {
  createMemoryInbox,
  type ItemState,
  type MemoryInbox,
  type MemoryInboxOptions,
} from './memory.ts';
export { type RunConversationOptions, runConversation } from './run.ts';
export type {
  ConversationInbox,
  ConversationRun,
  Handover,
  InboxItem,
  InboxPolicy,
  InboxRead,
  Opened,
  PolicyChoice,
  PolicyMoment,
  ReplyRun,
  ReplyStart,
  TakeAt,
} from './types.ts';
