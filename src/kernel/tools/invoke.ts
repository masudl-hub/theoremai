/**
 * Host-initiated tool execution entrypoint.
 *
 * @module
 */

import {
  isAbortError,
  TheoremError,
  toErrorEvent,
  withPublicWording,
} from '../../guardrails/error.ts';
import { resolveTraceWriter } from '../../observability/policy.ts';
import { writeSpans } from '../../observability/trace.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import {
  type SpanHandle,
  startTrace,
  type TraceAttributes,
} from '../../observability/trace-span.ts';
import { startToolTrace, type ToolCallEnd, toolSpanName } from '../engine/tool-trace.ts';
import { optional, traceLinks } from '../engine/turn-trace.ts';
import type { KernelRegistry } from '../registry/kernel-registry.ts';
import { pickModel } from '../registry/resolve.ts';
import { turnDoneOf } from '../turn-events.ts';
import type { Profile, TurnEvent, TurnRequest } from '../types.ts';
import { failureEvent, newCallId, toolCallArguments, toolCallRequestEvent } from './events.ts';
import { executeRegisteredTool } from './execute.ts';
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
  registry: KernelRegistry,
  request: InvokeToolRequest,
  profile: Profile,
): Promise<TurnToolSnapshot> {
  const req = turnRequestFromInvoke(request);
  if (profile.type === 'decision') {
    throw new TheoremError('request', `Profile ${profile.id}: type 'decision' cannot invoke tools`); // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  // Host profiles bind no model — the allow list is the whole snapshot.
  const model = profile.type === 'host' ? undefined : pickModel(profile, request.model);
  return await prepareTurnToolSnapshot(registry.tools, profile, req, model);
}

/**
 * Execute a tool registered in `registry` without calling a model provider, and
 * write its trace record: one `execute_tool` root under the host's `traceparent`.
 *
 * The record is written however the call ends, including when the host stops
 * reading early or the call fails before the tool is reached. A call on an
 * unknown profile fails in `invokeTraced` and is recorded under the standard
 * observability policy, since there is no profile to read one from.
 */
async function* invokeTool(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  sinkOverride?: TraceSink,
): AsyncGenerator<TurnEvent> {
  const known = registry.profiles.find(request.profile);
  const { sink, policy } = resolveTraceWriter({
    override: sinkOverride,
    observability: known?.observability,
  });
  const callId = request.callId ?? newCallId(request.name);
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
    const lexicon = known?.lexicon;
    const traceparent = tree.root.traceparent();
    for await (const event of invokeTraced(
      registry,
      request,
      callId,
      openSpan,
      failBeforeTool,
      traceparent,
    )) {
      yield withPublicWording(event, lexicon);
    }
  } catch (err) {
    failBeforeTool(
      isAbortError(err) ? { outcome: 'cancelled' } : { outcome: 'error', thrown: err },
    );
    throw err;
  } finally {
    await writeSpans(sink, tree.collect(), policy, request.metadata);
  }
}

async function* invokeTraced(
  registry: KernelRegistry,
  request: InvokeToolRequest,
  callId: string,
  openSpan: (name: string, attributes: TraceAttributes) => SpanHandle,
  failBeforeTool: (end: ToolCallEnd) => void,
  traceparent: string,
): AsyncGenerator<TurnEvent> {
  const profile = registry.profiles.get(request.profile);
  const snapshot = request.snapshot
    ? cloneTurnToolSnapshot(request.snapshot)
    : await prepareInvokeSnapshot(registry, request, profile);

  // A host's own call is announced like a model's; a model's call was announced by its turn.
  if (request.callId === undefined) {
    yield toolCallRequestEvent({ name: request.name, callId }, toolCallArguments(request.input));
  }

  if (request.promoted?.length) {
    const { failure } = promoteLoadedTools(registry.tools, snapshot, request.promoted, profile);
    if (failure) {
      failBeforeTool({ outcome: 'error', failure });
      yield failureEvent({ name: request.name, callId }, failure);
      yield { type: 'done', stop: { kind: 'completed' }, traceparent };
      return;
    }
  }

  let gated = false;
  try {
    const handlers = request.onStage ? [request.onStage] : [];
    const settlement = yield* executeRegisteredTool({
      tools: registry.tools,
      profile,
      name: request.name,
      input: request.input,
      callId,
      ctx: {
        sessionPermissions: request.sessionPermissions,
        credentials: request.credentials,
        resolveHost: request.resolveHost,
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
    });
    gated = settlement.gated !== undefined;
  } catch (err) {
    yield toErrorEvent(err);
  }
  yield turnDoneOf({ stop: { kind: gated ? 'gate' : 'completed' }, traceparent }, snapshot);
}

export { invokeTool };
