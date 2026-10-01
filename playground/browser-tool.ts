import { clientAnsweredHandler } from '../src/surface/tools.ts';

/**
 * The handler for a function tool the browser answers: it returns what the
 * browser sent with `executeToolOnRelay({ callId, output })`, which the relay
 * bridge hands over as `ctx.host.clientOutput`. The tool's output schema checks it.
 * With no output the call fails to the model, naming the tool; so does a call
 * the bridge settled because the browser never answered (`host.clientTimedOut`).
 */
export const browserToolHandler = clientAnsweredHandler;
