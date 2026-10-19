/**
 * One Web-standard handler that serves a decision profile to `<TheoremDecision />`.
 *
 * - `GET  <base>`        → `{ interface }` the profile's handle, contract, and questions
 * - `POST <base>/decide` → `{ result }` the answers for the posted `{ state }`
 *
 * The host owns the questions: the browser sends only the state and the images it names,
 * so a visitor can't spend the host's key asking questions of their own.
 *
 * @module
 */

import {
  type DecisionProfile,
  type DecisionQuestion,
  defineProfile,
  type KeyVault,
  registerProfile,
  runDecision,
  type TraceSink,
  z,
} from '@theoremjs/agents';
import type { ClientTurnOptions } from '@theoremjs/agents/host';
import type { DecisionProfileDefinition } from '@theoremjs/agents/kernel';
import { decisionInterface } from '../client/decision-transport.ts';
import { readBody } from './handler.ts';
import { singleActionHandler } from './single-action.ts';

export type TheoremDecisionHandlerOptions = {
  /** Decision profile to serve. Registered with the kernel when the handler is created. */
  profile: DecisionProfile | DecisionProfileDefinition;
  /** The questions every decision asks, by id. */
  questions: Record<string, DecisionQuestion>;
  /** The host's keys by slot; the profile's key slot reads from it. */
  vault?: KeyVault;
  fetch?: typeof globalThis.fetch;
  /** Replaces the profile's `observability.writeTo` for every decision. */
  sink?: TraceSink;
  /** Host metadata kept on each decision's trace record, e.g. the signed-in user. */
  metadata?: (request: Request) => Record<string, unknown> | undefined;
  /** Who reads this host's replies: forwarded to `clientError` for a failure the handler catches. */
  clientEvents?: ClientTurnOptions;
  /**
   * Called with any error the handler catches, for reporting. Users read the
   * profile's labels wording for the error's kind, never the error itself.
   */
  onError?: (err: unknown, ctx: { request: Request }) => void;
};

const decideBodySchema = z.object({
  state: z.unknown(),
  assets: z.record(z.string(), z.object({ mimeType: z.string(), data: z.string() })).optional(),
});

export function createTheoremDecisionHandler(
  options: TheoremDecisionHandlerOptions,
): (request: Request) => Promise<Response> {
  const profile = defineProfile(options.profile as DecisionProfileDefinition);
  if (profile.type !== 'decision') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(
      `createTheoremDecisionHandler serves type 'decision'; got type '${profile.type}'.`,
    );
  }
  registerProfile(profile);
  return singleActionHandler(
    {
      action: 'decide',
      iface: decisionInterface(profile, options.questions),
      labels: profile.labels,
      clientEvents: options.clientEvents,
      onError: options.onError,
    },
    async (request) => {
      const body = await readBody(request, decideBodySchema);
      return runDecision(
        {
          profile: profile.id,
          // why: The kernel checks the state is non-null JSON within the profile's size.
          state: body.state as never,
          // why: The kernel checks each image's type and bytes before any request leaves.
          assets: body.assets as never,
          questions: options.questions,
          signal: request.signal,
          metadata: options.metadata?.(request),
        },
        { vault: options.vault, fetch: options.fetch, sink: options.sink },
      );
    },
  );
}
