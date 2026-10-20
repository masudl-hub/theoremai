import { z } from 'zod';
import { kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';
import { jsonObjectSchema } from '../../kernel/json.ts';
import {
  defineProtocol,
  type Protocol,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolRequest,
} from '../../kernel/protocols/mod.ts';
import type { ModelEvent } from '../../kernel/types.ts';
import { readGeminiApiError } from '../google/api-error.ts';
import { googleBuiltins } from '../google/builtins.ts';
import {
  type InteractionsRequest,
  thoughtSignature,
  toInteractionsBody,
} from '../google/interactions/framing.ts';
import {
  finalizeStructured,
  foldBody,
  foldPayload,
  missingMediaError,
  newStreamFold,
  openStepEvents,
  type StreamFold,
} from '../google/interactions/stream.ts';
import { asProtocolEvent } from '../shared/protocol-events.ts';

const state = z.strictObject({ interactionId: z.string().min(1) });
type State = z.infer<typeof state>;

/** What a `geminiInteractions` binding sets in `options`. */
export interface GeminiInteractionsOptions {
  store?: boolean;
  persistViaInteractionId?: boolean;
}

const options: z.ZodType<GeminiInteractionsOptions> = z
  .strictObject({
    store: z
      .boolean()
      .optional()
      .describe('Whether Google keeps the interaction. Off, nothing is stored server-side.'), // labels-exempt: builder field description, read by the studio and docs
    persistViaInteractionId: z.boolean().optional().describe(
      'Continue from the stored interaction instead of sending the conversation again. Needs store.', // labels-exempt: builder field description, read by the studio and docs
    ),
  })
  .refine(
    (value) => !value.persistViaInteractionId || value.store !== false,
    'persistViaInteractionId needs store', // labels-exempt: builder diagnostic
  );
type Options = z.infer<typeof options>;

function wireRequest(context: ProtocolContext<Options>, request: ProtocolRequest<State>) {
  const history = request.history ?? [];
  const previous = context.options.persistViaInteractionId
    ? request.state?.interactionId
    : undefined;
  const builtins = googleBuiltins(request.builtins);
  const wire = {
    ...request,
    apiId: context.apiId,
    history,
    builtins,
    state: undefined,
    tapUpstream: undefined,
    store: context.options.store,
    previousInteractionId: previous,
    continuation: previous
      ? [
          ...history.slice(request.stateHistoryLength ?? 0),
          ...request.input.map((part) => ({ role: 'user' as const, parts: [part] })),
        ]
      : undefined,
  } as InteractionsRequest;
  const body = jsonObjectSchema.parse(JSON.parse(JSON.stringify(toInteractionsBody(wire))));
  return { wire, body, wroteTools: builtins.map((builtin) => builtin.id) };
}

/** What one reply has given so far, beyond the shared fold. */
interface Reply {
  fold: StreamFold;
  done?: Extract<ProtocolEvent<State>, { type: 'done' }>;
}

/** The shared reader's events as protocol events; the `done` waits for the end, with the state to keep. */
function asProtocolEvents(
  events: readonly ModelEvent[],
  reply: Reply,
  persist: boolean,
): ProtocolEvent<State>[] {
  return events.flatMap((event): ProtocolEvent<State>[] => {
    if (event.type !== 'done') {
      const converted = asProtocolEvent<State>(event);
      return converted ? [converted] : [];
    }
    const { interactionId, ...done } = event as typeof event & { interactionId?: string };
    reply.done = {
      ...(done as Extract<ProtocolEvent<State>, { type: 'done' }>),
      ...(persist && interactionId ? { state: { interactionId } } : {}),
    };
    return [];
  });
}

/** Gemini's Interactions API: text, images, and speech, all at `/interactions`. */
export const geminiInteractions: Protocol<GeminiInteractionsOptions> = defineProtocol({
  id: 'geminiInteractions',
  name: 'Gemini Interactions',
  description: "Google's Interactions API for Gemini: text, images and speech at one endpoint.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { text: '/interactions', image: '/interactions', speech: '/interactions' },
  options,
  continuation: { version: 1, schema: state, keyOptions: ['store', 'persistViaInteractionId'] },
  reasoning: thoughtSignature,
  error(failure) {
    const kind = kindOfHttpStatus(failure.status);
    const record = asRecord(failure.body);
    const stated = record ? readGeminiApiError(record) : null;
    return new TheoremError(
      stated?.kind === 'auth' ? 'auth' : kind,
      stated?.message ?? `Gemini HTTP ${failure.status}`,
    );
  },
  create(context) {
    return {
      async *complete(request) {
        const { wire, body, wroteTools } = wireRequest(context, request);
        const stream = request.stream !== false;
        const persist = Boolean(context.options.persistViaInteractionId);
        const reply: Reply = { fold: newStreamFold() };
        const init = { stream, wroteTools, ...(stream ? { path: '/interactions?alt=sse' } : {}) };
        for await (const row of context.send(body, init)) {
          // why: an error row before any output is thrown, so the kernel can fall back to the other key.
          const failed = readGeminiApiError(row);
          if (failed) throw failed;
          const events = stream ? foldPayload(row, reply.fold) : foldBody(row, reply.fold);
          yield* asProtocolEvents(events, reply, persist);
          if (events.some((event) => event.type === 'error')) {
            yield* asProtocolEvents(openStepEvents(reply.fold), reply, persist);
            return;
          }
        }
        yield* asProtocolEvents(openStepEvents(reply.fold), reply, persist);
        yield* asProtocolEvents([...finalizeStructured(wire, reply.fold)], reply, persist);
        const missing = missingMediaError(wire, reply.fold);
        if (missing) yield* asProtocolEvents([missing], reply, persist);
        yield reply.done ?? { type: 'done', stop: { kind: 'stream_incomplete' } };
      },
    };
  },
});
