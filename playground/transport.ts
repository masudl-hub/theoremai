/**
 * Transport for the playground run tab: the profile is authored in the browser,
 * so every request carries the compiled payload to `/api/playground/*`, along
 * with the client-held `replay` state (permissions, paused call). That is safe
 * only because the playground user owns the whole profile and its tools.
 *
 * Product hosts keep the profile on the server — use `createHttpTransport`
 * with `createTheoremHandler` instead.
 *
 * @module
 */

import { z } from 'zod';
import {
  defineProfile,
  TheoremError,
  traceRecordSchema,
  TURN_EVENT_SCHEMAS,
  type TurnEvent,
} from '../mod.ts';
import { createTraceFeed, type TraceFeed } from '../react/src/client/trace-feed.ts';
import {
  type HttpOptions,
  postJson,
  postNdjson,
  type TheoremTransport,
  type TurnEventSink,
  type UnsupportedEvent,
  type WireLines,
} from '../react/src/client/transport.ts';
import { interfaceFromProfile, type ProfileInterface } from '../src/interface/mod.ts';
import { createToolRegistry } from '../src/kernel/tools/registry.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import { registerPlaygroundTools } from './tools.ts';
import type { Equals } from '../src/kernel/util/exact-type.ts';
import type { PlaygroundTraceLine } from './traces.ts';

/** Client-side interface for the draft profile carried by a run payload. */
export function playgroundInterface(payload: PlaygroundRunPayload): ProfileInterface {
  const tools = createToolRegistry();
  registerPlaygroundTools(tools, payload.customTools);
  return interfaceFromProfile(defineProfile(payload.profile), tools);
}

/**
 * The first line of a playground turn: the steer inbox the server opened for it.
 * The server picks the id, so a steer reaches only a run this browser started.
 */
export type PlaygroundSteerLine = { type: 'steer_inbox'; inbox: string };

type PlaygroundLine = TurnEvent | PlaygroundTraceLine | PlaygroundSteerLine;

const playgroundTraceLine = z.object({ type: z.literal('trace'), record: traceRecordSchema });
true satisfies Equals<z.infer<typeof playgroundTraceLine>, PlaygroundTraceLine>;
const playgroundSteerLine = z.object({ type: z.literal('steer_inbox'), inbox: z.string().min(1) });
true satisfies Equals<z.infer<typeof playgroundSteerLine>, PlaygroundSteerLine>;

/** A run stream's lines: turn events, and the playground's trace and steer inbox lines beside them. */
const playgroundLines: WireLines<PlaygroundLine> = {
  ...TURN_EVENT_SCHEMAS,
  trace: playgroundTraceLine,
  steer_inbox: playgroundSteerLine,
};

/** A run stream's lines: its steer inbox, turn events, and the trace records the run wrote. */
function routeLines(
  onEvent: TurnEventSink,
  traces: TraceFeed,
  onSteerInbox: (inbox: string) => void,
) {
  return (line: PlaygroundLine | UnsupportedEvent) => {
    if (line.type === 'trace') traces.push(line.record);
    else if (line.type === 'steer_inbox') onSteerInbox(line.inbox);
    else onEvent(line);
  };
}

function ignoreSteerInbox(): void {}

export function createPlaygroundTransport(
  payload: PlaygroundRunPayload,
  options: HttpOptions = {},
): TheoremTransport {
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    structured: payload.structured,
  };
  const traces = createTraceFeed();
  /** The server's steer inbox for each turn, by the client's turn id. */
  const inboxes = new Map<string, string>();
  return {
    describe: () => Promise.resolve(playgroundInterface(payload)),
    turn: async ({ replay, turnId, ...body }, onEvent, signal) => {
      try {
        await postNdjson(
          '/api/playground/turn',
          { ...compiled, ...replay, ...body },
          playgroundLines,
          routeLines(onEvent, traces, (inbox) => {
            if (turnId) inboxes.set(turnId, inbox);
          }),
          { ...options, signal },
        );
      } finally {
        if (turnId) inboxes.delete(turnId);
      }
    },
    invoke: (request, onEvent, signal) =>
      postNdjson(
        '/api/playground/invoke',
        // The answer as `theoremInvokeRequestSchema` reads it; `replay` carries the paused call.
        { ...compiled, ...request },
        playgroundLines,
        routeLines(onEvent, traces, ignoreSteerInbox),
        { ...options, signal },
      ),
    async steer({ turnId, id, inject }) {
      const inbox = inboxes.get(turnId);
      if (!inbox) {
        // lexicon-exempt: internal diagnostic; the user reads session.turn_ended
        throw new TheoremError('request', 'steer: the turn has not opened its inbox', {
          copy: { key: 'session.turn_ended' },
        });
      }
      // The server's inbox is the turn it steers, so the body is a `TheoremSteerRequest`.
      await postJson('/api/playground/turn/steer', { turnId: inbox, id, inject }, options);
    },
    traces,
  };
}
