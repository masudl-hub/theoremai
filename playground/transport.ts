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

import { defineProfile, type TurnEvent } from '../mod.ts';
import { createTraceFeed, type TraceFeed } from '../react/src/client/trace-feed.ts';
import {
  type HttpOptions,
  postJson,
  postNdjson,
  type TheoremTransport,
  type TurnEventSink,
} from '../react/src/client/transport.ts';
import { interfaceFromProfile, type ProfileInterface } from '../src/interface/mod.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import type { PlaygroundTraceLine } from './traces.ts';

/** Client-side interface for the draft profile carried by a run payload. */
export function playgroundInterface(payload: PlaygroundRunPayload): ProfileInterface {
  return interfaceFromProfile(defineProfile(payload.profile));
}

/** A run stream's lines: turn events, then the trace records the run wrote. */
function routeLines(onEvent: TurnEventSink, traces: TraceFeed) {
  return (line: TurnEvent | PlaygroundTraceLine) => {
    if (line.type === 'trace') traces.push(line.record);
    else onEvent(line);
  };
}

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
  return {
    describe: () => Promise.resolve(playgroundInterface(payload)),
    turn: ({ replay, ...body }, onEvent, signal) =>
      postNdjson(
        '/api/playground/turn',
        { ...compiled, ...replay, ...body },
        routeLines(onEvent, traces),
        { ...options, signal },
      ),
    invoke: ({ replay, credentials }, onEvent, signal) =>
      postNdjson(
        '/api/playground/invoke',
        { ...compiled, ...replay, credentials },
        routeLines(onEvent, traces),
        { ...options, signal },
      ),
    async steer(body) {
      await postJson('/api/playground/turn/steer', body, options);
    },
    traces,
  };
}
