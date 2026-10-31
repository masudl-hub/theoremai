/**
 * One Web-standard handler that serves a decision profile to `<TheoremDecision />`.
 *
 * - `GET  <base>`        → `{ interface }` the profile's handle, contract, and questions
 * - `POST <base>/decide` → `{ result }` the answers for the posted `{ state }`
 *
 * The host owns the questions: the browser sends only the state, the images it names and,
 * when the host builds its questions for each decision, the input its builder takes. A
 * visitor can't spend the host's key asking questions of their own.
 *
 * @module
 */

import {
  type DecisionAsset,
  type DecisionJson,
  type DecisionProfile,
  type DecisionQuestion,
  defineProfile,
  type KeyVault,
  registerProfile,
  runDecision,
  TheoremError,
  type TraceSink,
  z,
} from '@theoremjs/agents';
import type { ClientTurnOptions } from '@theoremjs/agents/host';
import { type DecisionProfileDefinition, jsonSchemaFromZod } from '@theoremjs/agents/kernel';
import { decisionAssets, decisionInterface, questionViews } from '../client/decision-transport.ts';
import { readBody } from './handler.ts';
import { singleActionHandler } from './single-action.ts';

/**
 * Questions built for each decision: from its state and, when `input` is set, from what the page
 * fills in beside it. The handler checks the input against `input` before `build` sees it.
 */
export type DecisionQuestionsBuilder<Input = undefined> = {
  /** What the page fills in for each decision, beyond the state. */
  input?: z.ZodType<Input>;
  /** The questions one decision asks, by id. */
  build(call: {
    state: Exclude<DecisionJson, null>;
    input: Input;
  }): Record<string, DecisionQuestion> | Promise<Record<string, DecisionQuestion>>;
};

/** Whether `questions` are built for each decision, not fixed. */
export function isQuestionsBuilder(
  questions: unknown,
): questions is DecisionQuestionsBuilder<unknown> {
  return (
    typeof questions === 'object' &&
    questions !== null &&
    typeof (questions as { build?: unknown }).build === 'function'
  );
}

export type TheoremDecisionHandlerOptions<Input = unknown> = {
  /** Decision profile to serve. Registered with the kernel when the handler is created. */
  profile: DecisionProfile | DecisionProfileDefinition;
  /** The questions every decision asks, by id, or a builder that makes them for each decision. */
  questions: Record<string, DecisionQuestion> | DecisionQuestionsBuilder<Input>;
  /**
   * Images every decision sends, by the reference its questions write, such as `<ghs02>`. The page
   * sees them, to draw a box on one; a page image with one of their names is refused.
   */
  images?: Record<string, DecisionAsset>;
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
  input: z.unknown().optional(),
});

export function createTheoremDecisionHandler<Input = unknown>(
  options: TheoremDecisionHandlerOptions<Input>,
): (request: Request) => Promise<Response> {
  const profile = defineProfile(options.profile as DecisionProfileDefinition);
  if (profile.type !== 'decision') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(
      `createTheoremDecisionHandler serves type 'decision'; got type '${profile.type}'.`,
    );
  }
  registerProfile(profile);
  const { questions } = options;
  const builder = isQuestionsBuilder(questions)
    ? (questions as DecisionQuestionsBuilder<Input>)
    : undefined;
  const fixed = builder ? {} : (questions as Record<string, DecisionQuestion>);
  return singleActionHandler(
    {
      action: 'decide',
      iface: builder
        ? {
            ...decisionInterface(profile, {}, options.images),
            build: builder.input ? { input: jsonSchemaFromZod(builder.input, 'input') } : {},
          }
        : decisionInterface(profile, fixed, options.images),
      labels: profile.labels,
      clientEvents: options.clientEvents,
      onError: options.onError,
    },
    async (request) => {
      const body = await readBody(request, decideBodySchema);
      if (builder && (body.state === null || body.state === undefined))
        // labels-exempt: internal diagnostic; the user reads error.request
        throw new TheoremError('request', 'a decision needs a state');
      // why: The kernel checks the state is JSON within the profile's size; a builder is never handed null.
      const state = body.state as Exclude<DecisionJson, null>;
      const asked = builder
        ? await builder.build({ state, input: builtInput(builder, body.input) })
        : fixed;
      const result = await runDecision(
        {
          profile: profile.id,
          state,
          // why: The kernel checks each image's type and bytes before any request leaves.
          assets: decisionAssets(options.images, body.assets as never),
          questions: asked,
          signal: request.signal,
          metadata: options.metadata?.(request),
        },
        { vault: options.vault, fetch: options.fetch, sink: options.sink },
      );
      return builder ? { ...result, questions: questionViews(asked) } : result;
    },
  );
}

/** The page's input, checked against the builder's: refused as a bad request when it does not fit. */
function builtInput<Input>(builder: DecisionQuestionsBuilder<Input>, input: unknown): Input {
  if (!builder.input) return undefined as Input;
  const parsed = builder.input.safeParse(input);
  if (!parsed.success)
    // labels-exempt: internal diagnostic; the user reads error.request
    throw new TheoremError('request', `the questions' input does not fit: ${parsed.error.message}`);
  return parsed.data;
}
