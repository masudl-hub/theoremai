import type { ProfileDefinition } from '../mod.ts';
import type { PageTools } from '../react/src/client/live/live-page-tool.ts';
import type { ToolRegistration } from './registrations.ts';
import type { StudioRunPayload } from './run-payload.ts';
import { stubOutputFromSchema } from './stub.ts';

/** The first message on a studio live call: the draft the relay runs, on a scope of its own. */
export type StudioLiveDraftMessage = {
  type: 'draft';
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
};

/**
 * A live call that carries its draft, so no other call can reach or replace it.
 * The react client's `LiveConnection` accepts it as is.
 */
export function studioLiveConnection(payload: StudioRunPayload): {
  openMessage: StudioLiveDraftMessage;
} {
  const openMessage: StudioLiveDraftMessage = {
    type: 'draft',
    profile: payload.profile,
    customTools: payload.customTools,
  };
  return { openMessage };
}

/**
 * The studio's page: for each tool the page answers (`answeredBy: 'page'`), a function that
 * answers with the tool's stub. A host's page does the real thing here.
 */
export function studioPageTools(
  payload: Pick<StudioRunPayload, 'customTools'>,
): PageTools {
  const pageTools: PageTools = {};
  for (const tool of payload.customTools) {
    if (tool.type !== 'function' || tool.answeredBy !== 'page') continue;
    const output = tool.stubResponse ?? stubOutputFromSchema(tool.outputSchema);
    pageTools[tool.name] = () => ({ output });
  }
  return pageTools;
}
