/**
 * The conversation core for a server that takes messages with no HTTP request of the page's: a
 * messaging channel, a voice channel, a timer. It runs the replies `createTheoremHandler` runs,
 * on the same stores, and reads a `CoreContext` where the handler reads the `Request`.
 *
 * @module
 */

import { type ProviderHostOptions, TheoremError, type ToolGate } from '@theoremjs/agents';
import type { InboxItem } from '@theoremjs/agents/conversation';
import type { ToolBackgroundService } from '@theoremjs/agents/kernel';
import {
  type AppInbox,
  type ConversationCore,
  chatOf,
  createConversationCore,
  type ReplyPrepare,
} from './conversation-core.ts';
import type { SettledOperation } from './conversation-inbox.ts';
import type { TheoremHandlerOptions } from './handler.ts';
import { type CoreContext, sessionParts } from './session-calls.ts';
import { createMemorySteerInbox } from './steer-inbox.ts';

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
  | 'notifyRetryMs'
  | 'lateResultsDecider'
  | 'conversationLeaseMs'
  | 'steerInbox'
  | 'clientEvents'
> & {
  /**
   * The app's `TurnWiring.prepare`. With `inbox`, it is also given the reply's hold, so the turn
   * it returns can tell the model the items the reply reads: at once, or from its `onStage`.
   */
  prepare?: ReplyPrepare<Item>;
  /** Host options for registered providers, or a factory for apps that pick keys per run. */
  provider:
    | ProviderHostOptions
    | ((at: CoreContext, model?: string) => ProviderHostOptions | Promise<ProviderHostOptions>);
  /** The service for tools with a `background` setting, for the session of `at`. */
  background?: (at: CoreContext) => ToolBackgroundService;
  /** Check current resource access before disclosing a saved tool result. Read-only. */
  authorizeToolReplay?: (
    at: CoreContext,
    operation: SettledOperation,
  ) => boolean | Promise<boolean>;
  /** The sign-in URL for an OAuth gate. */
  authorizationUrl?: (
    challenge: Extract<ToolGate, { kind: 'auth' }>['authChallenge'],
    at: CoreContext,
  ) => string | Promise<string>;
  /** Called with any error a run reports and does not throw. */
  onError?: (err: unknown, at: CoreContext) => void;
  /**
   * The `lateResultsDecider`'s wake: start a reply to no message for the conversation under
   * `ref`, such as by a queued call to `wake`. Required with `lateResultsDecider`.
   */
  wake?: (at: CoreContext, ref: string) => Promise<void>;
  /**
   * The app's own inbox, for the runs of one context. Every reply then runs under a hold of the
   * conversation in it. Not with `lateResultsDecider`: the app's inbox holds every item a reply
   * is told.
   */
  inbox?: (at: CoreContext) => AppInbox<Item>;
};

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
    chat,
    steer: options.steerInbox ?? createMemorySteerInbox(),
    options: {
      prepare: options.prepare,
      onStage: options.onStage,
      pageToolTimeoutMs: options.pageToolTimeoutMs,
      notifier: options.notifier,
      notifyRetryMs: options.notifyRetryMs,
      lateResultsDecider: options.lateResultsDecider,
      conversationLeaseMs: options.conversationLeaseMs,
      clientEvents: options.clientEvents,
      background: options.background,
      authorizeToolReplay: options.authorizeToolReplay,
      authorizationUrl: options.authorizationUrl,
      onError: options.onError,
      inbox: options.inbox,
      provider: (at, model) => (typeof provider === 'function' ? provider(at, model) : provider),
      wake: (at, ref) => (wake ? wake(at, ref) : Promise.resolve()),
    },
  });
}
