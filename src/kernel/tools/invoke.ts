/**
 * Host-initiated tool execution entrypoint.
 *
 * @module
 */

import { toErrorEvent } from '../../guardrails/error.ts';
import { getProfile } from '../registry/profiles.ts';
import { pickModel } from '../registry/resolve.ts';
import type { Profile, TurnEvent, TurnRequest } from '../types.ts';
import { executeRegisteredTool, newCallId } from './execute.ts';
import { cloneTurnToolSnapshot, prepareTurnToolSnapshot, promoteLoadedTools } from './resolve.ts';
import type { InvokeToolRequest, TurnToolSnapshot } from './types.ts';

function turnRequestFromInvoke(request: InvokeToolRequest): TurnRequest {
  return {
    profile: request.profile,
    path: request.path,
    sessionPermissions: request.sessionPermissions,
    input: request.turnInput,
    model: request.model,
    host: request.host,
  };
}

async function prepareInvokeSnapshot(
  request: InvokeToolRequest,
  profile: Profile,
): Promise<TurnToolSnapshot> {
  const req = turnRequestFromInvoke(request);
  // Host profiles bind no model — the allow list is the whole snapshot.
  if (profile.type === 'decision') {
    // lexicon-exempt: developer contract error
    throw new Error(`Profile ${profile.id}: type 'decision' cannot invoke tools`);
  }
  const model = profile.type === 'host' ? undefined : pickModel(profile, request.model);
  return await prepareTurnToolSnapshot(profile, req, model);
}

/** Execute a registered tool without calling a model provider. */
async function* invokeTool(request: InvokeToolRequest): AsyncGenerator<TurnEvent> {
  const profile = getProfile(request.profile);
  const callId = newCallId(request.name);
  const snapshot = request.snapshot
    ? cloneTurnToolSnapshot(request.snapshot)
    : await prepareInvokeSnapshot(request, profile);

  if (request.promoted?.length) {
    const { failure } = promoteLoadedTools(snapshot, request.promoted, profile);
    if (failure) {
      yield {
        type: 'tool',
        tool: {
          name: request.name,
          callId,
          phase: 'error',
          failure,
        },
      };
      yield { type: 'done', stop: { kind: 'completed' } };
      return;
    }
  }

  let sawGate = false;
  let sawError = false;
  try {
    const handlers = request.onStage ? [request.onStage] : [];
    for await (const event of executeRegisteredTool({
      profile,
      name: request.name,
      input: request.input,
      callId,
      ctx: {
        sessionPermissions: request.sessionPermissions,
        credentials: request.credentials,
        path: request.path,
        signal: request.signal,
        resume: request.resume,
        host: request.host,
      },
      snapshot,
      stages: {
        handlers,
        profile,
        step: 1,
        history: () => [],
        injectAllowed: false,
        host: request.host,
        signal: request.signal,
      },
    })) {
      yield event;
      if (event.type !== 'tool') {
        continue;
      }
      if (event.tool?.phase === 'gate') {
        sawGate = true;
      }
      if (event.tool?.phase === 'error') {
        sawError = true;
      }
    }
  } catch (err) {
    yield toErrorEvent(err);
    sawError = true;
  }
  const stopKind = sawGate ? 'gate' : sawError ? 'completed' : 'completed';
  yield {
    type: 'done',
    stop: { kind: stopKind },
    ...(sawGate ? { tools: snapshot } : {}),
  };
}

export { invokeTool };
