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

import { defineProfile, TheoremError, type TurnEvent } from '../mod.ts';
import { createTraceFeed, type TraceFeed } from '../react/src/client/trace-feed.ts';
import {
  type HttpOptions,
  postJson,
  postNdjson,
  type TheoremTransport,
  type TurnEventSink,
} from '../react/src/client/transport.ts';
import { interfaceFromProfile, type ProfileInterface } from '../src/interface/mod.ts';
import { createToolRegistry } from '../src/kernel/tools/registry.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import { registerPlaygroundTools } from './tools.ts';
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

/** A run stream's lines: its steer inbox, turn events, and the trace records the run wrote. */
function routeLines(
  onEvent: TurnEventSink,
  traces: TraceFeed,
  onSteerInbox: (inbox: string) => void,
) {
  return (line: PlaygroundLine) => {
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
          routeLines(onEvent, traces, (inbox) => {
            if (turnId) inboxes.set(turnId, inbox);
          }),
          { ...options, signal },
        );
      } finally {
        if (turnId) inboxes.delete(turnId);
      }
    },
    invoke: ({ gateId, replay, secret }, onEvent, signal) =>
      postNdjson(
        '/api/playground/invoke',
        // The gate's call id, so the result settles the call the model made.
        { ...compiled, ...replay, callId: gateId, ...(secret === undefined ? {} : { secret }) },
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
      await postJson('/api/playground/turn/steer', { inbox, id, inject }, options);
    },
    traces,
  };
}
