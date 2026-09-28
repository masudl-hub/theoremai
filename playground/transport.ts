/**
 * Every request carries the compiled payload and the client-held `replay` state (permissions,
 * paused call). That is safe only because the playground user owns the whole profile and its
 * tools; product hosts keep the profile on the server (`createHttpTransport` with
 * `createTheoremHandler`).
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
  type MalformedEvent,
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

export function playgroundInterface(payload: PlaygroundRunPayload): ProfileInterface {
  const tools = createToolRegistry();
  registerPlaygroundTools(tools, payload.customTools);
  return interfaceFromProfile(defineProfile(payload.profile), tools);
}

/** The server picks the id, so a steer reaches only a run this browser started. */
export type PlaygroundSteerLine = { type: 'steer_inbox'; inbox: string };

type PlaygroundLine = TurnEvent | PlaygroundTraceLine | PlaygroundSteerLine;

const playgroundTraceLine = z.object({ type: z.literal('trace'), record: traceRecordSchema });
true satisfies Equals<z.infer<typeof playgroundTraceLine>, PlaygroundTraceLine>;
const playgroundSteerLine = z.object({ type: z.literal('steer_inbox'), inbox: z.string().min(1) });
true satisfies Equals<z.infer<typeof playgroundSteerLine>, PlaygroundSteerLine>;

const playgroundLines: WireLines<PlaygroundLine> = {
  ...TURN_EVENT_SCHEMAS,
  trace: playgroundTraceLine,
  steer_inbox: playgroundSteerLine,
};

function routeLines(
  onEvent: TurnEventSink,
  traces: TraceFeed,
  onSteerInbox: (inbox: string) => void,
) {
  return (line: PlaygroundLine | UnsupportedEvent | MalformedEvent) => {
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
    turn: async (request, onEvent, signal) => {
      try {
        await postNdjson(
          '/api/playground/turn',
          { ...compiled, ...request },
          playgroundLines,
          routeLines(onEvent, traces, (inbox) => {
            if (request.turnId) inboxes.set(request.turnId, inbox);
          }),
          { ...options, signal },
        );
      } finally {
        if (request.turnId) inboxes.delete(request.turnId);
      }
    },
    invoke: (request, onEvent, signal) =>
      postNdjson(
        '/api/playground/invoke',
        // `replay` carries the paused call.
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
