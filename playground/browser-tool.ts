import type { ToolContext } from '../src/kernel/tools/types.ts';

/**
 * The handler for a function tool the browser answers: it returns what the
 * browser sent with `executeToolOnRelay({ callId, output })`, which the relay
 * bridge hands over as `ctx.host.clientOutput`. The tool's output schema checks it.
 * With no output the call fails to the model, naming the tool; so does a call
 * the bridge settled because the browser never answered (`host.clientTimedOut`).
 */
export function browserToolHandler(name: string): (input: unknown, ctx: ToolContext) => unknown {
  return (_input, ctx) => {
    const host = ctx.host as { clientOutput?: unknown; clientTimedOut?: boolean } | undefined;
    if (host && 'clientOutput' in host) return host.clientOutput;
    if (host?.clientTimedOut) {
      throw new Error("The page didn't answer. Read the state before trying again.");
    }
    throw new Error(`${name} runs in the browser, and the browser sent no result.`);
  };
}
