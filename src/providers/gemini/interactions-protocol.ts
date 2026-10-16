import { z } from 'zod';
import { kindOfHttpStatus, TheoremError } from '../../guardrails/error.ts';
import { asRecord } from '../../kernel/engine/record.ts';
import {
  defineProtocol,
  type HistoryMessage,
  type ProtocolContext,
  type ProtocolEvent,
  type TurnRequest,
} from '../../kernel/protocols/mod.ts';
import { jsonObjectSchema } from '../../kernel/provider-contract.ts';
import type { ProviderCompleteRequest, ProviderEvent } from '../../kernel/types.ts';
import { readGeminiApiError } from '../google/api-error.ts';
import { GOOGLE_BUILTIN_IDS } from '../google/builtins.ts';
import { toInteractionsBody } from '../google/interactions/framing.ts';
import {
  finalizeStructured,
  foldBody,
  foldPayload,
  missingMediaError,
  newStreamFold,
  openStepEvents,
  type StreamFold,
} from '../google/interactions/stream.ts';

const state = z.strictObject({ interactionId: z.string().min(1) });
type State = z.infer<typeof state>;

/** A thought's signature, for the tool call at `call` in the same assistant message. */
const reasoning = z.strictObject({
  call: z.number().int().min(0),
  signature: z.string().min(1),
});

const options = z
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

/** Puts each replayed thought signature back on the tool call it was written with. */
function withSignatures(history: readonly HistoryMessage[]): HistoryMessage[] {
  return history.map((message) => {
    const signed = (message.reasoning ?? []).flatMap((part) => {
      if (part.origin.protocol !== 'geminiInteractions') return [];
      const parsed = reasoning.safeParse(part.data);
      return parsed.success ? [parsed.data] : [];
    });
    if (!signed.length || !message.tool_calls) return message;
    const calls = message.tool_calls.map((call, index) => {
      const signature = signed.find((item) => item.call === index)?.signature;
      return signature ? { ...call, thoughtSignature: signature } : call;
    });
    return { ...message, tool_calls: calls };
  });
}

function wireRequest(context: ProtocolContext<Options>, request: TurnRequest<State>) {
  const history = withSignatures(request.history ?? []);
  const previous = context.options.persistViaInteractionId
    ? request.state?.interactionId
    : undefined;
  const builtins = request.builtins.filter((builtin) =>
    (GOOGLE_BUILTIN_IDS as readonly string[]).includes(builtin.id),
  );
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
  } as ProviderCompleteRequest;
  const body = jsonObjectSchema.parse(JSON.parse(JSON.stringify(toInteractionsBody(wire))));
  return { wire, body, wroteTools: builtins.map((builtin) => builtin.id) };
}

/** What one reply has given so far, beyond the shared fold. */
interface Reply {
  fold: StreamFold;
  calls: number;
  done?: Extract<ProtocolEvent<State>, { type: 'done' }>;
}

/** Old-shape events as protocol events: a call's thought signature becomes its own reasoning. */
function asProtocolEvents(
  events: readonly ProviderEvent[],
  reply: Reply,
  persist: boolean,
): ProtocolEvent<State>[] {
  return events.flatMap((event): ProtocolEvent<State>[] => {
    if (event.type === 'done') {
      const { interactionId, ...done } = event as typeof event & { interactionId?: string };
      reply.done = {
        ...(done as Extract<ProtocolEvent<State>, { type: 'done' }>),
        ...(persist && interactionId ? { state: { interactionId } } : {}),
      };
      return [];
    }
    if (event.type !== 'tool') return [event as ProtocolEvent<State>];
    if (event.tool.phase === 'error') return [{ type: 'error', errorKind: 'bad_response' }];
    if (event.tool.phase !== undefined) return [];
    const { thoughtSignature, ...call } = event.tool;
    const index = reply.calls++;
    return [
      ...(thoughtSignature
        ? [{ type: 'reasoning' as const, data: { call: index, signature: thoughtSignature } }]
        : []),
      { type: 'tool_call', call },
    ];
  });
}

/** Gemini's Interactions API: text, images and speech, all at `/interactions`. */
export const geminiInteractions = defineProtocol({
  id: 'geminiInteractions',
  name: 'Gemini Interactions',
  description: "Google's Interactions API for Gemini: text, images and speech at one endpoint.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { text: '/interactions', image: '/interactions', speech: '/interactions' },
  options,
  continuation: { version: 1, schema: state, keyOptions: ['store', 'persistViaInteractionId'] },
  reasoning,
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
        const reply: Reply = { fold: newStreamFold(), calls: 0 };
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
