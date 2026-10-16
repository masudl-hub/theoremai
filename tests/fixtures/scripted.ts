import { z } from 'zod';
import { jsonValueSchema } from '../../src/kernel/json.ts';
import { defineProtocol, type ProtocolEvent } from '../../src/kernel/protocols/protocol.ts';
import { defineProvider, header } from '../../src/kernel/protocols/provider.ts';
import type { ModelEvent, TurnModel } from '../../src/kernel/types.ts';

const ORIGIN = 'https://scripted.test';
const models = new Map<string, TurnModel>();

/** The protocol event a scripted model's event stands for. */
function protocolEvent(event: ModelEvent): ProtocolEvent {
  switch (event.type) {
    case 'tool':
      return { type: 'tool_call', call: event.tool as never };
    case 'done':
      return {
        type: 'done',
        stop: event.stop,
        ...(event.interrupted ? { interrupted: true } : {}),
      };
    default:
      return event as ProtocolEvent;
  }
}

/**
 * Stands in for the wire in engine tests: each call asks the host's `fetch` which scripted model
 * answers it (see `scriptedFetch`), then streams that model's events.
 */
export const scriptedProtocol = defineProtocol({
  id: 'scripted',
  name: 'Scripted',
  description: 'Streams the events a test scripted.',
  endpoints: {
    text: '/complete',
    image: '/complete',
    speech: '/complete',
    live: '/complete',
    decision: '/complete',
  },
  options: z.strictObject({}),
  reasoning: jsonValueSchema,
  create: (context) => ({
    async *complete(request) {
      const token = crypto.randomUUID();
      let model: TurnModel | undefined;
      for await (const row of context.send(
        {},
        // why: a scripted model is handed the built-ins with the request, so it writes them all.
        { stream: false, path: `/complete/${token}`, wroteTools: context.builtInTools },
      ))
        model = models.get(String(row.token));
      models.delete(token);
      if (!model) throw new Error('No scripted model answered this call');
      let done = false;
      for await (const event of model.complete(request)) {
        if (event.type === 'done') done = true;
        yield protocolEvent(event);
      }
      if (!done) yield { type: 'done', stop: { kind: 'completed' } };
    },
  }),
});

export const scriptedProvider = defineProvider({
  id: 'scripted',
  name: 'Scripted',
  description: 'Answers engine tests with scripted models.',
  key: z.string(),
  authorize: header('x-scripted-key'),
  serves: () => [{ protocol: scriptedProtocol, baseUrl: ORIGIN }],
});

/** A host `fetch` that answers the scripted protocol's calls with `model`. */
export function scriptedFetch(model: TurnModel): typeof fetch {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const token = url.pathname.split('/').at(-1);
    if (url.origin !== ORIGIN || !token)
      return Promise.reject(new Error(`Unexpected fetch in a scripted run: ${url}`));
    models.set(token, model);
    return Promise.resolve(Response.json({ token }));
  };
}
