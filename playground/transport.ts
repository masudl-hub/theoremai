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

import { defineProfile } from '../mod.ts';
import {
  type HttpOptions,
  postJson,
  postNdjson,
  type TheoremTransport,
} from '../react/src/client/transport.ts';
import { interfaceFromProfile, type ProfileInterface } from '../src/interface/mod.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';

/** Client-side interface for the draft profile carried by a run payload. */
export function playgroundInterface(payload: PlaygroundRunPayload): ProfileInterface {
  return interfaceFromProfile(defineProfile(payload.profile));
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
  return {
    describe: () => Promise.resolve(playgroundInterface(payload)),
    turn: ({ replay, ...body }, onEvent, signal) =>
      postNdjson('/api/playground/turn', { ...compiled, ...replay, ...body }, onEvent, {
        ...options,
        signal,
        failureLabel: 'Turn failed',
      }),
    invoke: ({ replay, credentials }, onEvent, signal) =>
      postNdjson('/api/playground/invoke', { ...compiled, ...replay, credentials }, onEvent, {
        ...options,
        signal,
        failureLabel: 'Invoke failed',
      }),
    async steer(body) {
      await postJson('/api/playground/turn/steer', body, { ...options, failureLabel: 'Steer failed' });
    },
  };
}
