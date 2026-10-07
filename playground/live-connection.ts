import type { ProfileDefinition } from '../mod.ts';
import type { PageTools } from '../react/src/client/live/live-page-tool.ts';
import type { ToolRegistration } from './registrations.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import { stubOutputFromSchema } from './stub.ts';

/** The first message on a playground live call: the draft the relay runs, on a scope of its own. */
export type PlaygroundLiveDraftMessage = {
  type: 'draft';
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
};

/**
 * A live call that carries its draft, so no other call can reach or replace it.
 * The react client's `LiveConnection` accepts it as is.
 */
export function playgroundLiveConnection(payload: PlaygroundRunPayload): {
  openMessage: PlaygroundLiveDraftMessage;
} {
  const openMessage: PlaygroundLiveDraftMessage = {
    type: 'draft',
    profile: payload.profile,
    customTools: payload.customTools,
  };
  return { openMessage };
}

/**
 * The playground's page: for each tool the page answers (`answeredBy: 'page'`), a function that
 * answers with the tool's stub. A host's page does the real thing here.
 */
export function playgroundPageTools(
  payload: Pick<PlaygroundRunPayload, 'customTools'>,
): PageTools {
  const pageTools: PageTools = {};
  for (const tool of payload.customTools) {
    if (tool.type !== 'function' || tool.answeredBy !== 'page') continue;
    const output = tool.stubResponse ?? stubOutputFromSchema(tool.outputSchema);
    pageTools[tool.name] = () => ({ output });
  }
  return pageTools;
}
