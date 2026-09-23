/**
 * Host-initiated tool execution entrypoint.
 *
 * @module
 */

import { isAbortError, TheoremError, toErrorEvent } from '../../guardrails/error.ts';
import { resolveTraceWriter } from '../../observability/policy.ts';
import { writeTrace } from '../../observability/trace.ts';
import { buildRecord } from '../../observability/trace-record.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import {
  type SpanHandle,
  startTrace,
  type TraceAttributes,
} from '../../observability/trace-span.ts';
import { startToolTrace, type ToolCallEnd, toolSpanName } from '../engine/tool-trace.ts';
import { optional, traceLinks } from '../engine/turn-trace.ts';
import { getProfile, profileObservability } from '../registry/profiles.ts';
import { pickModel } from '../registry/resolve.ts';
import type { Profile, TurnEvent, TurnRequest } from '../types.ts';
import { executeRegisteredTool, newCallId, toolCallArguments } from './execute.ts';
import { cloneTurnToolSnapshot, prepareTurnToolSnapshot, promoteLoadedTools } from './resolve.ts';
import { plainToolInput } from './schema.ts';
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
  if (profile.type === 'decision') {
    throw new TheoremError(`Profile ${profile.id}: type 'decision' cannot invoke tools`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  // Host profiles bind no model — the allow list is the whole snapshot.
  const model = profile.type === 'host' ? undefined : pickModel(profile, request.model);
  return await prepareTurnToolSnapshot(profile, req, model);
}

/**
 * Execute a registered tool without calling a model provider, and write its
 * trace record: one `execute_tool` root under the host's `traceparent`.
 *
 * The record is written however the call ends, including when the host stops
 * reading early or the call fails before the tool is reached.
 */
async function* invokeTool(
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: profileObservability(request.profile),
  });
  const callId = newCallId(request.name);
  const tree = startTrace(toolSpanName(request.name), {
    attributes: {
      'gen_ai.agent.name': request.profile,
      ...optional('gen_ai.conversation.id', request.conversationId),
    },
    links: traceLinks(request.links),
    ...(request.traceparent ? { traceparent: request.traceparent } : {}),
  });
  // The root is this call's span: the executor stamps it rather than opening one.
  const openSpan = (_name: string, attributes: TraceAttributes) => {
    tree.root.set(attributes);
    return tree.root;
  };
  const failBeforeTool = (end: ToolCallEnd) =>
    startToolTrace(openSpan, {
      name: request.name,
      callId,
      call: { arguments: toolCallArguments(plainToolInput(request.input)) },
    }).end(end);
  try {
    yield* invokeTraced(request, callId, openSpan, failBeforeTool, tree.root.traceparent());
  } catch (err) {
    failBeforeTool(
      isAbortError(err) ? { outcome: 'cancelled' } : { outcome: 'error', thrown: err },
    );
    throw err;
  } finally {
    await writeTrace(
      sink,
      buildRecord({
        spans: tree.collect(),
        policy,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }),
      policy,
    );
  }
}

async function* invokeTraced(
  request: InvokeToolRequest,
  callId: string,
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  failBeforeTool: (end: ToolCallEnd) => void,
  traceparent: string,
): AsyncGenerator<TurnEvent> {
  const profile = getProfile(request.profile);
  const snapshot = request.snapshot
    ? cloneTurnToolSnapshot(request.snapshot)
    : await prepareInvokeSnapshot(request, profile);

  if (request.promoted?.length) {
    const { failure } = promoteLoadedTools(snapshot, request.promoted, profile);
    if (failure) {
      failBeforeTool({ outcome: 'error', errorType: failure.code });
      yield {
        type: 'tool',
        tool: {
          name: request.name,
          callId,
          phase: 'error',
          failure,
        },
      };
      yield { type: 'done', stop: { kind: 'completed' }, traceparent };
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
      openSpan,
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
    traceparent,
  };
}

export { invokeTool };
