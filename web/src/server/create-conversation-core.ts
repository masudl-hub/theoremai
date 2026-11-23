/**
 * The conversation core for a server that takes messages with no HTTP request of the page's: a
 * messaging channel, a voice channel, a timer. It runs the replies `createTheoremHandler` runs,
 * on the same stores, and reads a `CoreContext` where the handler reads the `Request`.
 *
 * @module
 */

import { type ProviderHostOptions, TheoremError } from '@theoremjs/agents';
import type { InboxItem } from '@theoremjs/agents/conversation';
import {
  type ConversationCore,
  chatOf,
  createConversationCore,
  endingsOf,
  type ReplyWiring,
} from './conversation-core.ts';
import type { TheoremHandlerOptions } from './handler.ts';
import { createOwnInbox } from './own-inbox.ts';
import { type CallHooks, type CoreContext, sessionParts } from './session-calls.ts';

/**
 * Options for {@link createTheoremConversationCore}. Each option picked from
 * `TheoremHandlerOptions` means what it means there. The others take the run's `CoreContext`
 * where the handler's take the `Request`.
 */
export type TheoremConversationCoreOptions<Item extends InboxItem = InboxItem> = Pick<
  TheoremHandlerOptions,
  | 'profile'
  | 'onStage'
  | 'sessionStore'
  | 'conversationStore'
  | 'credentialStore'
  | 'gateTtlMs'
  | 'operationRetentionMs'
  | 'pageToolBroker'
  | 'pageToolTimeoutMs'
  | 'notifier'
  | 'replyFeed'
  | 'notifyRetryMs'
  | 'lateResultsDecider'
  | 'conversationLeaseMs'
  | 'clientEvents'
> &
  ReplyWiring<Item> & {
    /** Host options for registered providers, or a factory for apps that pick keys per run. */
    provider:
      | ProviderHostOptions
      | ((at: CoreContext, model?: string) => ProviderHostOptions | Promise<ProviderHostOptions>);
    /**
     * The `lateResultsDecider`'s wake: start a reply to no message for the conversation under
     * `ref`, such as by a queued call to `wake`. Required with `lateResultsDecider`.
     */
    wake?: (at: CoreContext, ref: string) => Promise<void>;
  } & CallHooks;

/** Creates the conversation core for `options.profile`. */
export function createTheoremConversationCore<Item extends InboxItem = InboxItem>(
  options: TheoremConversationCoreOptions<Item>,
): ConversationCore {
  const name = 'createTheoremConversationCore';
  const chat = chatOf(name, options.profile, options.conversationStore);
  const { provider, wake } = options;
  if (options.lateResultsDecider && !wake) {
    // labels-exempt: builder config error at setup; no user sees it
    throw new TheoremError('config', `${name} needs \`wake\` with \`lateResultsDecider\``);
  }
  return createConversationCore<Item>({
    ...sessionParts(name, chat.profile, options),
    ...endingsOf(chat, options),
    chat,
    own: createOwnInbox(),
    options: {
      prepare: options.prepare,
      onStage: options.onStage,
      pageToolTimeoutMs: options.pageToolTimeoutMs,
      notifier: options.notifier,
      notifyRetryMs: options.notifyRetryMs,
      replyFeed: options.replyFeed,
      lateResultsDecider: options.lateResultsDecider,
      conversationLeaseMs: options.conversationLeaseMs,
      clientEvents: options.clientEvents,
      background: options.background,
      authorizeToolReplay: options.authorizeToolReplay,
      authorizationUrl: options.authorizationUrl,
      onError: options.onError,
      inbox: options.inbox,
      beforeSave: options.beforeSave,
      afterSave: options.afterSave,
      compact: options.compact,
      provider: (at, model) => (typeof provider === 'function' ? provider(at, model) : provider),
      wake: (at, ref) => (wake ? wake(at, ref) : Promise.resolve()),
    },
  });
}
